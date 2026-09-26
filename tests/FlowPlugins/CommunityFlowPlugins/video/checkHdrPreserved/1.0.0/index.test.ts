import { plugin } from
  '../../../../../../FlowPluginsTs/CommunityFlowPlugins/video/checkHdrPreserved/1.0.0/index';
import { IpluginInputArgs } from '../../../../../../FlowPluginsTs/FlowHelpers/1.0.0/interfaces/interfaces';
import { IFileObject, Istreams } from '../../../../../../FlowPluginsTs/FlowHelpers/1.0.0/interfaces/synced/IFileObject';

const sampleH265 = require('../../../../../sampleData/media/sampleH265_1.json');

// Side data as reported by FFprobe 8.x for real files.
const mdcv = { side_data_type: 'Mastering display metadata', max_luminance: '1000/1' };
const cll = { side_data_type: 'Content light level metadata', max_content: 1000, max_average: 400 };
const dovi = (profile: number, compat: number, el = 0, rpu = 1) => ({
  side_data_type: 'DOVI configuration record',
  dv_version_major: 1,
  dv_version_minor: 0,
  dv_profile: profile,
  dv_level: 6,
  rpu_present_flag: rpu,
  el_present_flag: el,
  bl_present_flag: 1,
  dv_bl_signal_compatibility_id: compat,
});

const fileWith = (
  id: string,
  codec: string,
  transfer: string | undefined,
  sideData: Record<string, unknown>[],
): IFileObject => {
  const file = JSON.parse(JSON.stringify(sampleH265));
  file._id = id;
  const video = (file.ffProbeData.streams as Istreams[]).find((s) => s.codec_type === 'video') as Istreams;
  video.codec_name = codec;
  video.color_transfer = transfer;
  video.side_data_list = sideData;
  return file;
};

describe('checkHdrPreserved Plugin', () => {
  let baseArgs: IpluginInputArgs;
  let scanIndividualFile: jest.Mock;

  const setOriginal = (codec: string, transfer: string | undefined, sideData: Record<string, unknown>[]) => {
    scanIndividualFile.mockResolvedValue(fileWith('/library/movie.mkv', codec, transfer, sideData));
  };
  const setOutput = (codec: string, transfer: string | undefined, sideData: Record<string, unknown>[]) => {
    baseArgs.inputFileObj = fileWith('/cache/movie.mkv', codec, transfer, sideData);
  };
  const logs = () => (baseArgs.jobLog as jest.Mock).mock.calls.flat().join('\n');

  beforeEach(() => {
    scanIndividualFile = jest.fn();
    baseArgs = {
      inputs: {},
      variables: {} as IpluginInputArgs['variables'],
      inputFileObj: fileWith('/cache/movie.mkv', 'hevc', 'bt709', []),
      // Tdarr's stored record of the original, without side data.
      originalLibraryFile: {
        _id: '/library/movie.mkv', file: '/library/movie.mkv', DB: 'lib1', footprintId: 'fp1',
      },
      scanIndividualFile,
      deps: { axiosMiddleware: jest.fn() },
      jobLog: jest.fn(),
    } as unknown as IpluginInputArgs;
    setOriginal('hevc', 'bt709', []);
  });

  describe('Preserved', () => {
    it('should pass SDR to SDR', async () => {
      const result = await plugin(baseArgs);
      expect(result.outputNumber).toBe(1);
      expect(result.outputFileObj).toBe(baseArgs.inputFileObj);
    });

    it('should pass HEVC HDR10 to AV1 HDR10 (HEVC MDCV/CLL are per frame, not stream level)', async () => {
      setOriginal('hevc', 'smpte2084', []);
      setOutput('av1', 'smpte2084', [cll, mdcv]);
      expect((await plugin(baseArgs)).outputNumber).toBe(1);
    });

    it('should pass HEVC DV profile 8.1 to AV1 DV profile 10.1', async () => {
      setOriginal('hevc', 'smpte2084', [dovi(8, 1)]);
      setOutput('av1', 'smpte2084', [cll, mdcv, dovi(10, 1)]);
      expect((await plugin(baseArgs)).outputNumber).toBe(1);
    });

    it('should pass HEVC DV profile 7 to AV1 DV profile 10.1', async () => {
      setOriginal('hevc', 'smpte2084', [dovi(7, 6, 1)]);
      setOutput('av1', 'smpte2084', [cll, mdcv, dovi(10, 1)]);
      expect((await plugin(baseArgs)).outputNumber).toBe(1);
    });

    it('should pass HLG to AV1 DV profile 10.4', async () => {
      setOriginal('hevc', 'arib-std-b67', [dovi(8, 4)]);
      setOutput('av1', 'arib-std-b67', [dovi(10, 4)]);
      expect((await plugin(baseArgs)).outputNumber).toBe(1);
    });

    it('should pass a remux that keeps HEVC DV as it was', async () => {
      setOriginal('hevc', 'smpte2084', [dovi(8, 1)]);
      setOutput('hevc', 'smpte2084', [dovi(8, 1)]);
      expect((await plugin(baseArgs)).outputNumber).toBe(1);
    });

    it('should pass when DV is dropped and Check Dolby Vision is off', async () => {
      baseArgs.inputs.checkDolbyVision = false;
      setOriginal('hevc', 'smpte2084', [dovi(8, 1)]);
      setOutput('av1', 'smpte2084', []);
      expect((await plugin(baseArgs)).outputNumber).toBe(1);
    });
  });

  describe('Lost', () => {
    it('should fail when HDR becomes SDR', async () => {
      setOriginal('hevc', 'smpte2084', []);
      setOutput('av1', 'bt709', []);
      expect((await plugin(baseArgs)).outputNumber).toBe(2);
      expect(logs()).toContain('HDR transfer lost');
    });

    it('should fail when the HDR transfer tag is missing', async () => {
      setOriginal('hevc', 'arib-std-b67', []);
      setOutput('av1', undefined, []);
      expect((await plugin(baseArgs)).outputNumber).toBe(2);
      expect(logs()).toContain('output is untagged');
    });

    it('should fail when stream-level mastering display metadata is lost', async () => {
      setOriginal('av1', 'smpte2084', [mdcv, cll]);
      setOutput('av1', 'smpte2084', [cll]);
      expect((await plugin(baseArgs)).outputNumber).toBe(2);
      expect(logs()).toContain('mastering display metadata lost');
    });

    it('should fail when stream-level content light level metadata is lost', async () => {
      setOriginal('av1', 'smpte2084', [mdcv, cll]);
      setOutput('av1', 'smpte2084', [mdcv]);
      expect((await plugin(baseArgs)).outputNumber).toBe(2);
      expect(logs()).toContain('content light level metadata lost');
    });

    it('should fail when Dolby Vision is silently dropped', async () => {
      setOriginal('hevc', 'smpte2084', [dovi(8, 1)]);
      setOutput('av1', 'smpte2084', [cll, mdcv]);
      expect((await plugin(baseArgs)).outputNumber).toBe(2);
      expect(logs()).toContain('Dolby Vision lost: original is profile 8');
    });

    it('should still check HDR when Check Dolby Vision is off', async () => {
      baseArgs.inputs.checkDolbyVision = false;
      setOriginal('hevc', 'smpte2084', [dovi(8, 1)]);
      setOutput('av1', 'bt709', []);
      expect((await plugin(baseArgs)).outputNumber).toBe(2);
    });
  });

  describe('Invalid Dolby Vision output', () => {
    it.each([
      ['no RPU', dovi(10, 1, 0, 0), 'no RPU'],
      ['AV1 tagged profile 8', dovi(8, 1), 'must be profile 10'],
      ['AV1 with an enhancement layer', dovi(10, 1, 1), 'single layer'],
      ['AV1 with compatibility id 0', dovi(10, 0), 'compatibility id 0'],
      ['AV1 PQ with HLG compatibility id 4', dovi(10, 4), 'compatibility id 4'],
    ])('should fail on %s', async (_name, record, message) => {
      setOriginal('hevc', 'smpte2084', [dovi(8, 1)]);
      setOutput('av1', 'smpte2084', [record]);
      expect((await plugin(baseArgs)).outputNumber).toBe(2);
      expect(logs()).toContain(message);
    });
  });

  describe('Scanning the original', () => {
    it('should rescan the original rather than trust the stored record', async () => {
      await plugin(baseArgs);
      expect(scanIndividualFile).toHaveBeenCalledWith(
        {
          _id: '/library/movie.mkv', file: '/library/movie.mkv', DB: 'lib1', footprintId: 'fp1',
        },
        expect.objectContaining({ mediaInfoScan: false }),
      );
    });

    it('should fall back to the server API on nodes without scanIndividualFile', async () => {
      delete (baseArgs as Partial<IpluginInputArgs>).scanIndividualFile;
      const axiosMiddleware = baseArgs.deps.axiosMiddleware as jest.Mock;
      axiosMiddleware.mockResolvedValue(fileWith('/library/movie.mkv', 'hevc', 'smpte2084', [dovi(8, 1)]));
      setOutput('av1', 'smpte2084', []);

      expect((await plugin(baseArgs)).outputNumber).toBe(2);
      expect(axiosMiddleware).toHaveBeenCalledWith('api/v2/scan-individual-file', expect.anything());
    });

    it('should throw when placed after Replace Original File', async () => {
      baseArgs.inputFileObj._id = '/library/movie.mkv';
      await expect(plugin(baseArgs)).rejects.toThrow('Replace Original File');
    });

    it('should throw when the working file has no video stream', async () => {
      baseArgs.inputFileObj.ffProbeData.streams = [];
      await expect(plugin(baseArgs)).rejects.toThrow('Working file has no video stream');
    });

    it('should throw when the original has no video stream', async () => {
      const original = fileWith('/library/movie.mkv', 'hevc', 'bt709', []);
      original.ffProbeData.streams = [];
      scanIndividualFile.mockResolvedValue(original);
      await expect(plugin(baseArgs)).rejects.toThrow('Original file has no video stream');
    });
  });
});
