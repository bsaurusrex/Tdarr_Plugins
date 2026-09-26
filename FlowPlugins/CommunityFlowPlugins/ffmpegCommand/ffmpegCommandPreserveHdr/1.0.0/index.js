"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var child_process_1 = require("child_process");
var flowUtils_1 = require("../../../../FlowHelpers/1.0.0/interfaces/flowUtils");
/* eslint no-plusplus: ["error", { "allowForLoopAfterthoughts": true }] */
var details = function () { return ({
    name: 'Preserve HDR and Dolby Vision',
    description: "Carry HDR and Dolby Vision from the source into a re-encoded video stream.\n  Use after 'Set Video Encoder'. SDR streams and stream copies are left untouched.\n  \\n\\n\n  For HDR sources (PQ or HLG) this sets BT.2020 primaries and matrix, and the source's own transfer\n  function, so HLG is not relabelled as PQ and 10-bit output is not left untagged.\n  \\n\\n\n  For Dolby Vision sources encoded with libsvtav1 it adds -dolbyvision 1, which writes AV1 Dolby\n  Vision profile 10. This needs FFmpeg 8.0 or newer: older builds, and hardware AV1 encoders, drop the\n  Dolby Vision RPU without any error and output plain HDR10. The flag is only added when the source\n  has Dolby Vision, because forcing it on a source without Dolby Vision makes libsvtav1 fail.\n  \\n\\n\n  Only profile 8 and profile 10 sources are passed through. Profile 7 RPUs are copied verbatim and\n  still expect the enhancement layer, which AV1 cannot carry, so convert them to profile 8.1 first\n  (e.g. dovi_tool). Profile 5 has no HDR10 compatible base layer.",
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
}); };
exports.details = details;
var hdrTransfers = ['smpte2084', 'arib-std-b67'];
var minDvFfmpegMajor = 8;
var getEncoder = function (stream) {
    var i = stream.outputArgs.findIndex(function (arg) { return /^-c(odec)?:/.test(String(arg)); });
    return i >= 0 ? String(stream.outputArgs[i + 1] || '') : '';
};
var getDvProfile = function (stream) {
    var record = (Array.isArray(stream.side_data_list) ? stream.side_data_list : [])
        .find(function (sideData) { return (sideData === null || sideData === void 0 ? void 0 : sideData.side_data_type) === 'DOVI configuration record'
        || (sideData === null || sideData === void 0 ? void 0 : sideData.dv_profile) !== undefined; });
    return record ? Number(record.dv_profile) : undefined;
};
var getFfmpegMajorVersion = function (ffmpegPath) {
    try {
        var out = (0, child_process_1.execFileSync)(ffmpegPath, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 20000 });
        var match = String(out).match(/ffmpeg version n?(\d+)\.\d+/);
        return match ? Number(match[1]) : undefined;
    }
    catch (err) {
        return undefined;
    }
};
// eslint-disable-next-line @typescript-eslint/no-unused-vars
var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    (0, flowUtils_1.checkFfmpegCommandInit)(args);
    var failOnUnsupported = String(args.inputs.dolbyVisionUnsupported) !== 'continue';
    var ffmpegMajor;
    var ffmpegChecked = false;
    var streams = args.variables.ffmpegCommand.streams;
    for (var i = 0; i < streams.length; i++) {
        var stream = streams[i];
        if (stream.codec_type === 'video' && !stream.removed) {
            var encoder = getEncoder(stream);
            var transfer = String(stream.color_transfer || '');
            var dvProfile = getDvProfile(stream);
            if (!encoder || encoder === 'copy') {
                args.jobLog("Stream ".concat(stream.index, ": not being encoded, HDR and Dolby Vision are copied as-is"));
            }
            else if (!hdrTransfers.includes(transfer) && dvProfile === undefined) {
                args.jobLog("Stream ".concat(stream.index, ": SDR source, nothing to preserve"));
            }
            else {
                // A Dolby Vision profile 8.1/10.1 source is PQ even if the transfer tag is missing.
                var trc = transfer === 'arib-std-b67' ? 'arib-std-b67' : 'smpte2084';
                stream.outputArgs.push('-color_primaries:{outputIndex}', 'bt2020', '-color_trc:{outputIndex}', trc, '-colorspace:{outputIndex}', 'bt2020nc');
                args.jobLog("Stream ".concat(stream.index, ": HDR source (").concat(trc, "), set BT.2020 colour tags"));
                if (dvProfile !== undefined) {
                    var reason = '';
                    if (encoder !== 'libsvtav1') {
                        reason = "encoder is ".concat(encoder, ", only libsvtav1 can write a Dolby Vision RPU");
                    }
                    else if (dvProfile !== 8 && dvProfile !== 10) {
                        reason = "Dolby Vision profile ".concat(dvProfile, " cannot be passed through to AV1")
                            + "".concat(dvProfile === 7 ? ', convert it to profile 8.1 first' : '');
                    }
                    else {
                        if (!ffmpegChecked) {
                            ffmpegMajor = getFfmpegMajorVersion(args.ffmpegPath);
                            ffmpegChecked = true;
                        }
                        if (ffmpegMajor === undefined) {
                            reason = 'could not read the FFmpeg version';
                        }
                        else if (ffmpegMajor < minDvFfmpegMajor) {
                            reason = "FFmpeg ".concat(ffmpegMajor, " is older than ").concat(minDvFfmpegMajor, ".0 and would silently drop the RPU");
                        }
                    }
                    if (reason === '') {
                        stream.outputArgs.push('-dolbyvision:{outputIndex}', '1');
                        args.jobLog("Stream ".concat(stream.index, ": Dolby Vision profile ").concat(dvProfile, " source,")
                            + ' added -dolbyvision 1 (AV1 profile 10)');
                    }
                    else if (failOnUnsupported) {
                        throw new Error("Stream ".concat(stream.index, ": Dolby Vision cannot be preserved: ").concat(reason));
                    }
                    else {
                        args.jobLog("Stream ".concat(stream.index, ": Dolby Vision will be dropped (").concat(reason, "),")
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
exports.plugin = plugin;
