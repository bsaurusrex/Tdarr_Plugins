import { execFileSync } from 'child_process';
import { checkFfmpegCommandInit } from '../../../../FlowHelpers/1.0.0/interfaces/flowUtils';
import {
  IffmpegCommandStream,
  IpluginDetails,
  IpluginInputArgs,
  IpluginOutputArgs,
} from '../../../../FlowHelpers/1.0.0/interfaces/interfaces';

/* eslint no-plusplus: ["error", { "allowForLoopAfterthoughts": true }] */
const details = (): IpluginDetails => ({
  name: 'Preserve HDR and Dolby Vision',
  description: `Carry HDR and Dolby Vision from the source into a re-encoded video stream.
  Use after 'Set Video Encoder'. SDR streams and stream copies are left untouched.
  \\n\\n
  For HDR sources (PQ or HLG) this sets BT.2020 primaries and matrix, and the source's own transfer
  function, so HLG is not relabelled as PQ and 10-bit output is not left untagged.
  \\n\\n
  For Dolby Vision sources encoded with libsvtav1 it adds -dolbyvision 1, which writes AV1 Dolby
  Vision profile 10. This needs FFmpeg 8.0 or newer: older builds, and hardware AV1 encoders, drop the
  Dolby Vision RPU without any error and output plain HDR10. The flag is only added when the source
  has Dolby Vision, because forcing it on a source without Dolby Vision makes libsvtav1 fail.
  \\n\\n
  Only profile 8 and profile 10 sources are passed through. Profile 7 RPUs are copied verbatim and
  still expect the enhancement layer, which AV1 cannot carry, so convert them to profile 8.1 first
  (e.g. dovi_tool). Profile 5 has no HDR10 compatible base layer.`,
  style: {
    borderColor: '#6efefc',
  },
  tags: 'video',
  isStartPlugin: false,
  pType: '',
  requiresVersion: '2.11.01',
  sidebarPosition: -1,
  icon: '',
  inputs: [
    {
      label: 'If Dolby Vision Cannot Be Preserved',
      name: 'dolbyVisionUnsupported',
      type: 'string',
      defaultValue: 'fail',
      inputUI: {
        type: 'dropdown',
        options: ['fail', 'continue'],
      },
      tooltip: 'What to do when the source has Dolby Vision but it cannot be carried over: the encoder is'
        + ' not libsvtav1, FFmpeg is older than 8.0, or the Dolby Vision profile is not 8 or 10.'
        + '\\n\\nfail: fail the flow, so the Dolby Vision source is not replaced.'
        + '\\ncontinue: encode without Dolby Vision. HDR10 or HLG is still preserved.',
    },
  ],
  outputs: [
    {
      number: 1,
      tooltip: 'Continue to next plugin',
    },
  ],
});

interface IsideData {
  side_data_type?: string,
  dv_profile?: number,
}

const hdrTransfers = ['smpte2084', 'arib-std-b67'];
const minDvFfmpegMajor = 8;

const getEncoder = (stream: IffmpegCommandStream): string => {
  const i = stream.outputArgs.findIndex((arg) => /^-c(odec)?:/.test(String(arg)));
  return i >= 0 ? String(stream.outputArgs[i + 1] || '') : '';
};

const getDvProfile = (stream: IffmpegCommandStream): number | undefined => {
  const record = (Array.isArray(stream.side_data_list) ? stream.side_data_list : [])
    .find((sideData: IsideData) => sideData?.side_data_type === 'DOVI configuration record'
      || sideData?.dv_profile !== undefined);
  return record ? Number(record.dv_profile) : undefined;
};

const getFfmpegMajorVersion = (ffmpegPath: string): number | undefined => {
  try {
    const out = execFileSync(ffmpegPath, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 20000 });
    const match = String(out).match(/ffmpeg version n?(\d+)\.\d+/);
    return match ? Number(match[1]) : undefined;
  } catch (err) {
    return undefined;
  }
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const plugin = (args: IpluginInputArgs): IpluginOutputArgs => {
  const lib = require('../../../../../methods/lib')();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
  args.inputs = lib.loadDefaultValues(args.inputs, details);

  checkFfmpegCommandInit(args);

  const failOnUnsupported = String(args.inputs.dolbyVisionUnsupported) !== 'continue';
  let ffmpegMajor: number | undefined;
  let ffmpegChecked = false;

  const { streams } = args.variables.ffmpegCommand;
  for (let i = 0; i < streams.length; i++) {
    const stream = streams[i];
    if (stream.codec_type === 'video' && !stream.removed) {
      const encoder = getEncoder(stream);
      const transfer = String(stream.color_transfer || '');
      const dvProfile = getDvProfile(stream);

      if (!encoder || encoder === 'copy') {
        args.jobLog(`Stream ${stream.index}: not being encoded, HDR and Dolby Vision are copied as-is`);
      } else if (!hdrTransfers.includes(transfer) && dvProfile === undefined) {
        args.jobLog(`Stream ${stream.index}: SDR source, nothing to preserve`);
      } else {
        // A Dolby Vision profile 8.1/10.1 source is PQ even if the transfer tag is missing.
        const trc = transfer === 'arib-std-b67' ? 'arib-std-b67' : 'smpte2084';
        stream.outputArgs.push(
          '-color_primaries:{outputIndex}', 'bt2020',
          '-color_trc:{outputIndex}', trc,
          '-colorspace:{outputIndex}', 'bt2020nc',
        );
        args.jobLog(`Stream ${stream.index}: HDR source (${trc}), set BT.2020 colour tags`);

        if (dvProfile !== undefined) {
          let reason = '';
          if (encoder !== 'libsvtav1') {
            reason = `encoder is ${encoder}, only libsvtav1 can write a Dolby Vision RPU`;
          } else if (dvProfile !== 8 && dvProfile !== 10) {
            reason = `Dolby Vision profile ${dvProfile} cannot be passed through to AV1`
              + `${dvProfile === 7 ? ', convert it to profile 8.1 first' : ''}`;
          } else {
            if (!ffmpegChecked) {
              ffmpegMajor = getFfmpegMajorVersion(args.ffmpegPath);
              ffmpegChecked = true;
            }
            if (ffmpegMajor === undefined) {
              reason = 'could not read the FFmpeg version';
            } else if (ffmpegMajor < minDvFfmpegMajor) {
              reason = `FFmpeg ${ffmpegMajor} is older than ${minDvFfmpegMajor}.0 and would silently drop the RPU`;
            }
          }

          if (reason === '') {
            stream.outputArgs.push('-dolbyvision:{outputIndex}', '1');
            args.jobLog(`Stream ${stream.index}: Dolby Vision profile ${dvProfile} source,`
              + ' added -dolbyvision 1 (AV1 profile 10)');
          } else if (failOnUnsupported) {
            throw new Error(`Stream ${stream.index}: Dolby Vision cannot be preserved: ${reason}`);
          } else {
            args.jobLog(`Stream ${stream.index}: Dolby Vision will be dropped (${reason}),`
              + ' HDR is still preserved');
          }
        }
      }
    }
  }

  return {
    outputFileObj: args.inputFileObj,
    outputNumber: 1,
    variables: args.variables,
  };
};

export {
  details,
  plugin,
};
