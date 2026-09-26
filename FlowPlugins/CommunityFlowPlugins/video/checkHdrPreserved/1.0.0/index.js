"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
/* eslint no-plusplus: ["error", { "allowForLoopAfterthoughts": true }] */
var details = function () { return ({
    name: 'Check HDR and Dolby Vision Preserved',
    description: "Compare the working file with the original library file and check that HDR and Dolby Vision\n  survived processing. Place it after 'Execute' and before 'Replace Original File', while the original\n  is still on disk, and route output 2 to a failure path so the original is not replaced.\n  \\n\\n\n  Checks the first video stream of each file:\n  \\n- an HDR transfer (PQ or HLG) is still HDR\n  \\n- mastering display and content light level metadata are still present, when the original carries\n  them at stream level (HEVC usually carries them per frame, which this check does not read)\n  \\n- a Dolby Vision configuration record is still present and has an RPU\n  \\n- an AV1 Dolby Vision record is profile 10, single layer, with an HDR10 compatible base layer\n  (or HLG compatible for HLG)\n  \\n\\n\n  These failures are otherwise silent: FFmpeg before 8.0 and hardware AV1 encoders drop Dolby Vision\n  without an error, and a missing colour tag turns HDR into SDR.",
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
}); };
exports.details = details;
var hdrTransfers = ['smpte2084', 'arib-std-b67'];
var getHdrState = function (fileObj) {
    var _a;
    var stream = (((_a = fileObj === null || fileObj === void 0 ? void 0 : fileObj.ffProbeData) === null || _a === void 0 ? void 0 : _a.streams) || [])
        .find(function (s) { return s.codec_type === 'video'; });
    if (!stream) {
        return undefined;
    }
    var sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
    var has = function (type) { return sideData.some(function (sd) { return (sd === null || sd === void 0 ? void 0 : sd.side_data_type) === type; }); };
    return {
        codec: String(stream.codec_name || ''),
        transfer: String(stream.color_transfer || ''),
        mdcv: has('Mastering display metadata'),
        cll: has('Content light level metadata'),
        dovi: sideData.find(function (sd) { return (sd === null || sd === void 0 ? void 0 : sd.side_data_type) === 'DOVI configuration record'
            || (sd === null || sd === void 0 ? void 0 : sd.dv_profile) !== undefined; }),
    };
};
// Tdarr's stored record of the original may not include side data, so scan it again.
var scanOriginal = function (args) {
    var file = {
        _id: args.originalLibraryFile._id,
        file: args.originalLibraryFile.file,
        DB: args.originalLibraryFile.DB,
        footprintId: args.originalLibraryFile.footprintId,
    };
    var scanTypes = {
        exifToolScan: false,
        mediaInfoScan: false,
        closedCaptionScan: false,
    };
    if (typeof args.scanIndividualFile !== 'undefined') {
        return args.scanIndividualFile(file, scanTypes);
    }
    return args.deps.axiosMiddleware('api/v2/scan-individual-file', { file: file, scanTypes: scanTypes });
};
var findProblem = function (original, output, checkDolbyVision) {
    if (hdrTransfers.includes(original.transfer) && !hdrTransfers.includes(output.transfer)) {
        return "HDR transfer lost: original is ".concat(original.transfer, ", output is ").concat(output.transfer || 'untagged');
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
        return "Dolby Vision lost: original is profile ".concat(original.dovi.dv_profile, ", output has no DOVI record");
    }
    var dovi = output.dovi;
    if (dovi) {
        if (!dovi.rpu_present_flag) {
            return 'output has a DOVI record but no RPU (rpu_present_flag 0)';
        }
        if (output.codec === 'av1') {
            if (dovi.dv_profile !== 10) {
                return "AV1 output is Dolby Vision profile ".concat(dovi.dv_profile, ", AV1 must be profile 10");
            }
            if (dovi.el_present_flag) {
                return 'AV1 output claims an enhancement layer, AV1 Dolby Vision is single layer only';
            }
            var compat = dovi.dv_bl_signal_compatibility_id;
            if (compat !== 1 && !(compat === 4 && output.transfer === 'arib-std-b67')) {
                return "AV1 output has Dolby Vision compatibility id ".concat(compat, ", expected 1 (HDR10)")
                    + ' or 4 (HLG, for HLG output)';
            }
        }
    }
    return '';
};
var plugin = function (args) { return __awaiter(void 0, void 0, void 0, function () {
    var lib, checkDolbyVision, output, original, _a, describe, problem;
    var _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                lib = require('../../../../../methods/lib')();
                // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
                args.inputs = lib.loadDefaultValues(args.inputs, details);
                checkDolbyVision = args.inputs.checkDolbyVision === true
                    || String(args.inputs.checkDolbyVision) === 'true';
                if (args.inputFileObj._id === ((_b = args.originalLibraryFile) === null || _b === void 0 ? void 0 : _b._id)) {
                    throw new Error('The working file is the original library file, there is nothing to compare.'
                        + ' Place this plugin before Replace Original File.');
                }
                output = getHdrState(args.inputFileObj);
                if (!output) {
                    throw new Error('Working file has no video stream');
                }
                _a = getHdrState;
                return [4 /*yield*/, scanOriginal(args)];
            case 1:
                original = _a.apply(void 0, [_c.sent()]);
                if (!original) {
                    throw new Error('Original file has no video stream');
                }
                describe = function (s) { return "".concat(s.codec, " ").concat(s.transfer || 'untagged')
                    + "".concat(s.mdcv ? ' +MDCV' : '').concat(s.cll ? ' +CLL' : '')
                    + "".concat(s.dovi ? " +DV profile ".concat(s.dovi.dv_profile) : ''); };
                args.jobLog("Original: ".concat(describe(original)));
                args.jobLog("Output:   ".concat(describe(output)));
                problem = findProblem(original, output, checkDolbyVision);
                if (problem) {
                    args.jobLog("HDR/Dolby Vision NOT preserved: ".concat(problem));
                }
                else {
                    args.jobLog('HDR/Dolby Vision preserved');
                }
                return [2 /*return*/, {
                        outputFileObj: args.inputFileObj,
                        outputNumber: problem ? 2 : 1,
                        variables: args.variables,
                    }];
        }
    });
}); };
exports.plugin = plugin;
