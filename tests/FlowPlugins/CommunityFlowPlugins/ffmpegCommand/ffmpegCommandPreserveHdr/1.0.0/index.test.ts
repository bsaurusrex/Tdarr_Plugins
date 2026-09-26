import { execFileSync } from 'child_process';
import { plugin } from
  '../../../../../../FlowPluginsTs/CommunityFlowPlugins/ffmpegCommand/ffmpegCommandPreserveHdr/1.0.0/index';
import { IpluginInputArgs, IffmpegCommandStream } from
  '../../../../../../FlowPluginsTs/FlowHelpers/1.0.0/interfaces/interfaces';

jest.mock('child_process', () => ({ execFileSync: jest.fn() }));

const sampleH265 = require('../../../../../sampleData/media/sampleH265_1.json');

const mockedExecFileSync = execFileSync as unknown as jest.Mock;
const ffmpegVersion = (version: string) => mockedExecFileSync.mockReturnValue(
  `ffmpeg version ${version} Copyright (c) 2000-2025 the FFmpeg developers\nlibavcodec     62. 11.100\n`,
);

const doviRecord = (profile: number) => ({
  side_data_type: 'DOVI configuration record',
  dv_profile: profile,
  rpu_present_flag: 1,
  el_present_flag: profile === 7 ? 1 : 0,
  bl_present_flag: 1,
  dv_bl_signal_compatibility_id: profile === 5 ? 0 : 1,
});

describe('ffmpegCommandPreserveHdr Plugin', () => {
  let baseArgs: IpluginInputArgs;
  let video: IffmpegCommandStream;

  const outputArgs = () => video.outputArgs;

  beforeEach(() => {
    mockedExecFileSync.mockReset();
    ffmpegVersion('8.0.1');
    video = {
      index: 0,
      codec_name: 'hevc',
      codec_type: 'video',
      color_transfer: 'smpte2084',
      color_primaries: 'bt2020',
      removed: false,
      forceEncoding: false,
      mapArgs: ['-map', '0:0'],
      inputArgs: [],
      outputArgs: ['-c:{outputIndex}', 'libsvtav1', '-crf', '28'],
    };
    baseArgs = {
      inputs: {},
      variables: {
        ffmpegCommand: {
          init: true,
          inputFiles: [],
          streams: [
            video,
            {
              index: 1,
              codec_name: 'eac3',
              codec_type: 'audio',
              removed: false,
              forceEncoding: false,
              mapArgs: ['-map', '0:1'],
              inputArgs: [],
              outputArgs: [],
            },
          ],
          container: 'mkv',
          hardwareDecoding: false,
          shouldProcess: true,
          overallInputArguments: [],
          overallOuputArguments: [],
        },
        flowFailed: false,
        user: {},
      },
      inputFileObj: JSON.parse(JSON.stringify(sampleH265)),
      ffmpegPath: '/usr/bin/ffmpeg',
      jobLog: jest.fn(),
    } as unknown as IpluginInputArgs;
  });

  describe('HDR', () => {
    it('should tag a PQ source with BT.2020 and PQ', () => {
      const result = plugin(baseArgs);

      expect(result.outputNumber).toBe(1);
      expect(outputArgs()).toEqual([
        '-c:{outputIndex}', 'libsvtav1', '-crf', '28',
        '-color_primaries:{outputIndex}', 'bt2020',
        '-color_trc:{outputIndex}', 'smpte2084',
        '-colorspace:{outputIndex}', 'bt2020nc',
      ]);
      expect(outputArgs()).not.toContain('-dolbyvision:{outputIndex}');
    });

    it('should keep HLG as HLG rather than relabel it as PQ', () => {
      video.color_transfer = 'arib-std-b67';
      plugin(baseArgs);
      const i = outputArgs().indexOf('-color_trc:{outputIndex}');
      expect(outputArgs()[i + 1]).toBe('arib-std-b67');
    });

    it('should tag HDR for any encoder, not only libsvtav1', () => {
      video.outputArgs = ['-c:{outputIndex}', 'hevc_nvenc'];
      plugin(baseArgs);
      expect(outputArgs()).toContain('-color_trc:{outputIndex}');
    });

    it('should not check the FFmpeg version for HDR10 without Dolby Vision', () => {
      plugin(baseArgs);
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });
  });

  describe('Untouched streams', () => {
    it('should leave SDR sources untouched', () => {
      video.color_transfer = 'bt709';
      video.color_primaries = 'bt709';
      plugin(baseArgs);
      expect(outputArgs()).toEqual(['-c:{outputIndex}', 'libsvtav1', '-crf', '28']);
    });

    it('should leave stream copies untouched, even with Dolby Vision', () => {
      video.outputArgs = [];
      video.side_data_list = [doviRecord(7)];
      plugin(baseArgs);
      expect(outputArgs()).toEqual([]);
    });

    it('should leave an explicit copy untouched', () => {
      video.outputArgs = ['-c:{outputIndex}', 'copy'];
      plugin(baseArgs);
      expect(outputArgs()).toEqual(['-c:{outputIndex}', 'copy']);
    });

    it('should skip removed video streams and non-video streams', () => {
      video.removed = true;
      plugin(baseArgs);
      expect(outputArgs()).toEqual(['-c:{outputIndex}', 'libsvtav1', '-crf', '28']);
      expect(baseArgs.variables.ffmpegCommand.streams[1].outputArgs).toEqual([]);
    });
  });

  describe('Dolby Vision', () => {
    it('should add -dolbyvision 1 for a profile 8 source with libsvtav1 on FFmpeg 8', () => {
      video.side_data_list = [doviRecord(8)];
      plugin(baseArgs);
      expect(outputArgs()).toEqual(expect.arrayContaining(['-dolbyvision:{outputIndex}', '1']));
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        '/usr/bin/ffmpeg',
        ['-hide_banner', '-version'],
        expect.anything(),
      );
    });

    it('should accept an n-prefixed version string (e.g. jellyfin-ffmpeg / git builds)', () => {
      ffmpegVersion('n8.1.2-Jellyfin');
      video.side_data_list = [doviRecord(8)];
      plugin(baseArgs);
      expect(outputArgs()).toContain('-dolbyvision:{outputIndex}');
    });

    it('should add -dolbyvision 1 for an AV1 profile 10 source', () => {
      video.codec_name = 'av1';
      video.side_data_list = [doviRecord(10)];
      plugin(baseArgs);
      expect(outputArgs()).toContain('-dolbyvision:{outputIndex}');
    });

    it('should treat a DV source with no transfer tag as PQ HDR', () => {
      delete video.color_transfer;
      video.side_data_list = [doviRecord(8)];
      plugin(baseArgs);
      const i = outputArgs().indexOf('-color_trc:{outputIndex}');
      expect(outputArgs()[i + 1]).toBe('smpte2084');
      expect(outputArgs()).toContain('-dolbyvision:{outputIndex}');
    });

    it('should check the FFmpeg version only once for several DV streams', () => {
      video.side_data_list = [doviRecord(8)];
      const second = { ...JSON.parse(JSON.stringify(video)), index: 2 };
      baseArgs.variables.ffmpegCommand.streams.push(second);
      plugin(baseArgs);
      expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
      expect(second.outputArgs).toContain('-dolbyvision:{outputIndex}');
    });

    describe.each([
      ['FFmpeg 7', () => { ffmpegVersion('7.1.4'); }, /older than 8\.0/],
      ['an unreadable FFmpeg version', () => { mockedExecFileSync.mockReturnValue('garbage'); }, /FFmpeg version/],
      ['FFmpeg that fails to run', () => {
        mockedExecFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
      }, /FFmpeg version/],
      ['a hardware encoder', () => { video.outputArgs = ['-c:{outputIndex}', 'av1_qsv']; }, /av1_qsv/],
      ['a profile 7 source', () => { video.side_data_list = [doviRecord(7)]; }, /profile 7.*8\.1/],
      ['a profile 5 source', () => { video.side_data_list = [doviRecord(5)]; }, /profile 5/],
    ])('when Dolby Vision cannot be preserved (%s)', (_name, setup, reason) => {
      beforeEach(() => {
        video.side_data_list = [doviRecord(8)];
        setup();
      });

      it('should fail by default', () => {
        expect(() => plugin(baseArgs)).toThrow(reason);
      });

      it('should continue without Dolby Vision when set to continue, keeping HDR', () => {
        baseArgs.inputs.dolbyVisionUnsupported = 'continue';
        const result = plugin(baseArgs);
        expect(result.outputNumber).toBe(1);
        expect(outputArgs()).not.toContain('-dolbyvision:{outputIndex}');
        expect(outputArgs()).toContain('-color_trc:{outputIndex}');
        expect(baseArgs.jobLog).toHaveBeenCalledWith(expect.stringMatching(reason));
      });
    });
  });

  it('should throw when the ffmpeg command has not been initialised', () => {
    baseArgs.variables.ffmpegCommand.init = false;
    expect(() => plugin(baseArgs)).toThrow();
  });
});
