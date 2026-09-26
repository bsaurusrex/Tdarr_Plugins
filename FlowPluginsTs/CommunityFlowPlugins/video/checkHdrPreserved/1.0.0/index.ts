import {
  IpluginDetails,
  IpluginInputArgs,
  IpluginOutputArgs,
} from '../../../../FlowHelpers/1.0.0/interfaces/interfaces';
import { IFileObject, Istreams } from '../../../../FlowHelpers/1.0.0/interfaces/synced/IFileObject';

/* eslint no-plusplus: ["error", { "allowForLoopAfterthoughts": true }] */
const details = (): IpluginDetails => ({
  name: 'Check HDR and Dolby Vision Preserved',
  description: `Compare the working file with the original library file and check that HDR and Dolby Vision
  survived processing. Place it after 'Execute' and before 'Replace Original File', while the original
  is still on disk, and route output 2 to a failure path so the original is not replaced.
  \\n\\n
  Checks the first video stream of each file:
  \\n- an HDR transfer (PQ or HLG) is still HDR
  \\n- mastering display and content light level metadata are still present, when the original carries
  them at stream level (HEVC usually carries them per frame, which this check does not read)
  \\n- a Dolby Vision configuration record is still present and has an RPU
  \\n- an AV1 Dolby Vision record is profile 10, single layer, with an HDR10 compatible base layer
  (or HLG compatible for HLG)
  \\n\\n
  These failures are otherwise silent: FFmpeg before 8.0 and hardware AV1 encoders drop Dolby Vision
  without an error, and a missing colour tag turns HDR into SDR.`,
  style: {
    borderColor: 'orange',
  },
  tags: 'video',
  isStartPlugin: false,
  pType: '',
  requiresVersion: '2.11.01',
  sidebarPosition: -1,
  icon: 'faQuestion',
  inputs: [
    {
      label: 'Check Dolby Vision',
      name: 'checkDolbyVision',
      type: 'boolean',
      defaultValue: 'true',
      inputUI: {
        type: 'switch',
      },
      tooltip: 'Also require Dolby Vision to be preserved. Turn off if the flow drops Dolby Vision on'
        + ' purpose and only HDR should be checked.',
    },
  ],
  outputs: [
    {
      number: 1,
      tooltip: 'HDR and Dolby Vision preserved (or the original had neither)',
    },
    {
      number: 2,
      tooltip: 'HDR or Dolby Vision lost or invalid, see the job log for the reason',
    },
  ],
});

interface IsideData {
  side_data_type?: string,
  dv_profile?: number,
  rpu_present_flag?: number,
  el_present_flag?: number,
  dv_bl_signal_compatibility_id?: number,
}

interface IhdrState {
  codec: string,
  transfer: string,
  mdcv: boolean,
  cll: boolean,
  dovi?: IsideData,
}

const hdrTransfers = ['smpte2084', 'arib-std-b67'];

const getHdrState = (fileObj: IFileObject): IhdrState | undefined => {
  const stream: Istreams | undefined = (fileObj?.ffProbeData?.streams || [])
    .find((s) => s.codec_type === 'video');
  if (!stream) {
    return undefined;
  }
  const sideData: IsideData[] = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
  const has = (type: string) => sideData.some((sd) => sd?.side_data_type === type);
  return {
    codec: String(stream.codec_name || ''),
    transfer: String(stream.color_transfer || ''),
    mdcv: has('Mastering display metadata'),
    cll: has('Content light level metadata'),
    dovi: sideData.find((sd) => sd?.side_data_type === 'DOVI configuration record'
      || sd?.dv_profile !== undefined),
  };
};

// Tdarr's stored record of the original may not include side data, so scan it again.
const scanOriginal = (args: IpluginInputArgs): Promise<IFileObject> => {
  const file = {
    _id: args.originalLibraryFile._id,
    file: args.originalLibraryFile.file,
    DB: args.originalLibraryFile.DB,
    footprintId: args.originalLibraryFile.footprintId,
  };
  const scanTypes = {
    exifToolScan: false,
    mediaInfoScan: false,
    closedCaptionScan: false,
  };
  if (typeof args.scanIndividualFile !== 'undefined') {
    return args.scanIndividualFile(file, scanTypes);
  }
  return args.deps.axiosMiddleware('api/v2/scan-individual-file', { file, scanTypes });
};

const findProblem = (original: IhdrState, output: IhdrState, checkDolbyVision: boolean): string => {
  if (hdrTransfers.includes(original.transfer) && !hdrTransfers.includes(output.transfer)) {
    return `HDR transfer lost: original is ${original.transfer}, output is ${output.transfer || 'untagged'}`;
  }
  if (original.mdcv && !output.mdcv) {
    return 'mastering display metadata lost';
  }
  if (original.cll && !output.cll) {
    return 'content light level metadata lost';
  }
  if (!checkDolbyVision) {
    return '';
  }
  if (original.dovi && !output.dovi) {
    return `Dolby Vision lost: original is profile ${original.dovi.dv_profile}, output has no DOVI record`;
  }
  const { dovi } = output;
  if (dovi) {
    if (!dovi.rpu_present_flag) {
      return 'output has a DOVI record but no RPU (rpu_present_flag 0)';
    }
    if (output.codec === 'av1') {
      if (dovi.dv_profile !== 10) {
        return `AV1 output is Dolby Vision profile ${dovi.dv_profile}, AV1 must be profile 10`;
      }
      if (dovi.el_present_flag) {
        return 'AV1 output claims an enhancement layer, AV1 Dolby Vision is single layer only';
      }
      const compat = dovi.dv_bl_signal_compatibility_id;
      if (compat !== 1 && !(compat === 4 && output.transfer === 'arib-std-b67')) {
        return `AV1 output has Dolby Vision compatibility id ${compat}, expected 1 (HDR10)`
          + ' or 4 (HLG, for HLG output)';
      }
    }
  }
  return '';
};

const plugin = async (args: IpluginInputArgs): Promise<IpluginOutputArgs> => {
  const lib = require('../../../../../methods/lib')();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
  args.inputs = lib.loadDefaultValues(args.inputs, details);

  const checkDolbyVision = args.inputs.checkDolbyVision === true
    || String(args.inputs.checkDolbyVision) === 'true';

  if (args.inputFileObj._id === args.originalLibraryFile?._id) {
    throw new Error('The working file is the original library file, there is nothing to compare.'
      + ' Place this plugin before Replace Original File.');
  }

  const output = getHdrState(args.inputFileObj);
  if (!output) {
    throw new Error('Working file has no video stream');
  }
  const original = getHdrState(await scanOriginal(args));
  if (!original) {
    throw new Error('Original file has no video stream');
  }

  const describe = (s: IhdrState) => `${s.codec} ${s.transfer || 'untagged'}`
    + `${s.mdcv ? ' +MDCV' : ''}${s.cll ? ' +CLL' : ''}`
    + `${s.dovi ? ` +DV profile ${s.dovi.dv_profile}` : ''}`;
  args.jobLog(`Original: ${describe(original)}`);
  args.jobLog(`Output:   ${describe(output)}`);

  const problem = findProblem(original, output, checkDolbyVision);
  if (problem) {
    args.jobLog(`HDR/Dolby Vision NOT preserved: ${problem}`);
  } else {
    args.jobLog('HDR/Dolby Vision preserved');
  }

  return {
    outputFileObj: args.inputFileObj,
    outputNumber: problem ? 2 : 1,
    variables: args.variables,
  };
};

export {
  details,
  plugin,
};
