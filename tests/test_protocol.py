"""Contract tests for the calibration binary protocol."""

import math
import unittest

from aw_calibrator.protocol import (
    CaptureProgress,
    CaptureResult,
    Command,
    DeviceInfo,
    DeviceParameters,
    Frame,
    Notice,
    Status,
    StreamDecoder,
    Telemetry,
    crc16_ccitt_false,
    encode_frame,
    pack_cancel_capture_response,
    pack_capture_progress,
    pack_capture_result,
    pack_device_info,
    pack_device_parameters,
    pack_notice,
    pack_reset_params_response,
    pack_set_params_request,
    pack_set_params_response,
    pack_set_stream_request,
    pack_set_stream_response,
    pack_start_capture_request,
    pack_start_capture_response,
    pack_telemetry,
    response_command,
    unpack_cancel_capture_response,
    unpack_capture_progress,
    unpack_capture_result,
    unpack_device_info,
    unpack_device_parameters,
    unpack_notice,
    unpack_reset_params_response,
    unpack_set_params_request,
    unpack_set_params_response,
    unpack_set_stream_request,
    unpack_set_stream_response,
    unpack_start_capture_request,
    unpack_start_capture_response,
    unpack_telemetry,
)


class ProtocolConstantsTests(unittest.TestCase):
    def test_locked_command_values(self):
        self.assertEqual(Command.GET_INFO, 0x01)
        self.assertEqual(Command.GET_PARAMS, 0x02)
        self.assertEqual(Command.SET_PARAMS, 0x03)
        self.assertEqual(Command.RESET_PARAMS, 0x04)
        self.assertEqual(Command.START_CAPTURE, 0x05)
        self.assertEqual(Command.CANCEL_CAPTURE, 0x06)
        self.assertEqual(Command.SET_STREAM, 0x07)
        self.assertEqual(Command.HEARTBEAT, 0x08)
        self.assertEqual(Command.TELEMETRY, 0x40)
        self.assertEqual(Command.CAPTURE_PROGRESS, 0x41)
        self.assertEqual(Command.CAPTURE_RESULT, 0x42)
        self.assertEqual(Command.NOTICE, 0x43)

    def test_locked_status_values(self):
        self.assertEqual(Status.OK, 0)
        self.assertEqual(Status.UNKNOWN_COMMAND, 1)
        self.assertEqual(Status.BAD_LENGTH, 2)
        self.assertEqual(Status.INVALID_PARAMETER, 3)
        self.assertEqual(Status.BUSY, 4)
        self.assertEqual(Status.SENSOR_UNAVAILABLE, 5)
        self.assertEqual(Status.CAPTURE_TIMEOUT, 6)
        self.assertEqual(Status.STORAGE_ERROR, 7)
        self.assertEqual(Status.INTERNAL_ERROR, 8)

    def test_response_command_sets_the_high_bit_for_every_request(self):
        self.assertEqual(
            tuple(response_command(command) for command in range(0x01, 0x09)),
            (0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88),
        )

    def test_response_command_rejects_response_and_event_command_values(self):
        for command in (0x80, 0x81, Command.TELEMETRY, Command.CAPTURE_PROGRESS, Command.CAPTURE_RESULT, Command.NOTICE):
            with self.subTest(command=command):
                with self.assertRaises(ValueError):
                    response_command(command)

    def test_response_command_preserves_unknown_low_bit_request_values(self):
        self.assertEqual(response_command(0x7F), 0xFF)


class FrameCodecTests(unittest.TestCase):
    def test_get_info_golden_frame(self):
        self.assertEqual(
            encode_frame(Command.GET_INFO, 0x1234),
            bytes.fromhex("A5 5A 04 00 01 01 34 12 17 B2"),
        )

    def test_set_params_golden_frame(self):
        self.assertEqual(
            encode_frame(Command.SET_PARAMS, 0x002A, pack_set_params_request(1.0, 0.0)),
            bytes.fromhex("A5 5A 0C 00 01 03 2A 00 00 00 80 3F 00 00 00 00 D0 D4"),
        )

    def test_telemetry_golden_frame(self):
        payload = pack_telemetry(
            Telemetry(7, 1, 25.0, 38.857, 38.983, 0.328, 0.328)
        )
        self.assertEqual(
            encode_frame(Command.TELEMETRY, 7, payload),
            bytes.fromhex(
                "A5 5A 1D 00 01 40 07 00 07 01 00 00 00 00 00 C8 41 "
                "91 6D 1B 42 98 EE 1B 42 9E EF A7 3E 9E EF A7 3E 33 DF"
            ),
        )

    def test_start_capture_request_and_correlated_error_golden_frames(self):
        capture_id = 0x0102030405060708
        self.assertEqual(
            encode_frame(
                Command.START_CAPTURE,
                0x0042,
                pack_start_capture_request(3, capture_id),
            ),
            bytes.fromhex(
                "A5 5A 0D 00 01 05 42 00 03 08 07 06 05 04 03 02 01 E2 92"
            ),
        )
        self.assertEqual(
            encode_frame(
                response_command(Command.START_CAPTURE),
                0x0042,
                pack_start_capture_response(Status.BUSY, 3, capture_id),
            ),
            bytes.fromhex(
                "A5 5A 0E 00 01 85 42 00 04 03 08 07 06 05 04 03 02 01 2A 22"
            ),
        )

    def test_shared_payload_vectors_reject_corruption_then_recover(self):
        vectors = (
            encode_frame(
                Command.SET_PARAMS,
                0x002A,
                pack_set_params_request(1.0, 0.0),
            ),
            encode_frame(
                Command.TELEMETRY,
                7,
                pack_telemetry(
                    Telemetry(7, 1, 25.0, 38.857, 38.983, 0.328, 0.328)
                ),
            ),
        )
        for valid in vectors:
            with self.subTest(command=valid[5]):
                corrupted = bytearray(valid)
                corrupted[-1] ^= 0x01
                decoder = StreamDecoder()
                self.assertEqual(decoder.feed(bytes(corrupted) + valid), [
                    Frame(valid[5], int.from_bytes(valid[6:8], "little"), valid[8:-2])
                ])

    def test_crc16_ccitt_false_matches_known_frame_body(self):
        self.assertEqual(crc16_ccitt_false(bytes.fromhex("04 00 01 01 34 12")), 0xB217)

    def test_capture_identity_keeps_version_and_frame_size_limits_unchanged(self):
        maximum = encode_frame(Command.CAPTURE_RESULT, 1, bytes(128))
        self.assertEqual(maximum[:5], bytes.fromhex("A5 5A 84 00 01"))
        with self.assertRaisesRegex(ValueError, "between 4 and 132"):
            encode_frame(Command.CAPTURE_RESULT, 1, bytes(129))

    def test_decoder_handles_noise_fragments_and_concatenated_frames(self):
        decoder = StreamDecoder()
        first = encode_frame(Command.GET_INFO, 1)
        second = encode_frame(Command.GET_PARAMS, 2)
        self.assertEqual(decoder.feed(b"noise" + first[:5]), [])
        frames = decoder.feed(first[5:] + second)
        self.assertEqual([(frame.command, frame.sequence) for frame in frames], [(1, 1), (2, 2)])

    def test_decoder_recovers_after_bad_crc(self):
        decoder = StreamDecoder()
        corrupted = bytearray(encode_frame(Command.GET_INFO, 1))
        corrupted[-1] ^= 0x01
        valid = encode_frame(Command.GET_PARAMS, 2)
        self.assertEqual(decoder.feed(bytes(corrupted) + valid), [Frame(2, 2, b"")])

    def test_decoder_recovers_after_impossible_length(self):
        decoder = StreamDecoder()
        impossible = bytes.fromhex("A5 5A 03 00 01 01 01 00")
        valid = encode_frame(Command.GET_PARAMS, 2)
        self.assertEqual(decoder.feed(impossible + valid), [Frame(2, 2, b"")])

    def test_decoder_preserves_unknown_command(self):
        decoder = StreamDecoder()
        unknown = encode_frame(0x7E, 0x55AA, b"\x99")
        self.assertEqual(decoder.feed(unknown), [Frame(0x7E, 0x55AA, b"\x99")])

    def test_decoder_rejects_unsupported_version_and_recovers(self):
        decoder = StreamDecoder()
        unsupported = bytes.fromhex("A5 5A 04 00 02 01 01 00 D8 E1")
        valid = bytes.fromhex("A5 5A 04 00 01 02 02 00 07 76")
        self.assertEqual(decoder.feed(unsupported + valid), [Frame(2, 2, b"")])


class PayloadCodecTests(unittest.TestCase):
    def test_device_info_payload_vector(self):
        value = DeviceInfo(Status.OK, "AW-C6-001", "1.2.3")
        expected = bytes.fromhex(
            "00 41 57 2D 43 36 2D 30 30 31 00 00 00 00 00 00 00 00 00 00 00 "
            "31 2E 32 2E 33 00 00 00 00 00 00 00 00 00 00 00"
        )
        self.assertEqual(pack_device_info(value), expected)
        self.assertEqual(unpack_device_info(expected), value)

    def test_device_parameters_and_params_response_payload_vectors(self):
        value = DeviceParameters(Status.OK, 42, True, False, 1.25, -2.5, 0.753)
        expected = bytes.fromhex("00 2A 00 01 00 00 00 A0 3F 00 00 20 C0 9C C4 40 3F")
        self.assertEqual(pack_device_parameters(value), expected)
        self.assertEqual(pack_set_params_response(value), expected)
        self.assertEqual(pack_reset_params_response(value), expected)
        for decoder in (unpack_device_parameters, unpack_set_params_response, unpack_reset_params_response):
            with self.subTest(decoder=decoder.__name__):
                decoded = decoder(expected)
                self.assertEqual(decoded.status, value.status)
                self.assertEqual(decoded.param_version, value.param_version)
                self.assertEqual(decoded.params_valid, value.params_valid)
                self.assertEqual(decoded.cal_dew_valid, value.cal_dew_valid)
                self.assertAlmostEqual(decoded.slope_k, value.slope_k, places=6)
                self.assertAlmostEqual(decoded.offset_b, value.offset_b, places=6)
                self.assertAlmostEqual(decoded.cal_dew, value.cal_dew, places=6)

    def test_set_params_request_payload_vector(self):
        expected = bytes.fromhex("00 00 A0 3F 00 00 20 C0")
        self.assertEqual(pack_set_params_request(1.25, -2.5), expected)
        self.assertEqual(unpack_set_params_request(expected), (1.25, -2.5))

    def test_start_capture_request_and_response_payload_vectors(self):
        capture_id = 0x0102030405060708
        request = bytes.fromhex("03 08 07 06 05 04 03 02 01")
        ok_response = bytes.fromhex("00 03 08 07 06 05 04 03 02 01")
        busy_response = bytes.fromhex("04 03 08 07 06 05 04 03 02 01")
        try:
            packed_request = pack_start_capture_request(3, capture_id)
            unpacked_request = unpack_start_capture_request(request)
            packed_ok = pack_start_capture_response(Status.OK, 3, capture_id)
            unpacked_ok = unpack_start_capture_response(ok_response)
            packed_busy = pack_start_capture_response(Status.BUSY, 3, capture_id)
            unpacked_busy = unpack_start_capture_response(busy_response)
        except (TypeError, ValueError) as error:
            self.fail(f"capture_id START schema is not implemented: {error}")
        self.assertEqual(packed_request, request)
        self.assertEqual(unpacked_request, (3, capture_id))
        self.assertEqual(packed_ok, ok_response)
        self.assertEqual(unpacked_ok, (Status.OK, 3, capture_id))
        self.assertEqual(packed_busy, busy_response)
        self.assertEqual(unpacked_busy, (Status.BUSY, 3, capture_id))

    def test_every_start_status_uses_the_correlated_ten_byte_schema(self):
        capture_id = 0xFEDCBA9876543210
        for status in Status:
            with self.subTest(status=status):
                payload = pack_start_capture_response(status, 2, capture_id)
                self.assertEqual(len(payload), 10)
                self.assertEqual(
                    unpack_start_capture_response(payload),
                    (status, 2, capture_id),
                )

    def test_start_capture_id_must_be_a_nonzero_uint64(self):
        for invalid in (0, -1, 1 << 64, True):
            with self.subTest(codec="request", invalid=invalid):
                with self.assertRaisesRegex(ValueError, "capture_id"):
                    pack_start_capture_request(1, invalid)
            with self.subTest(codec="response", invalid=invalid):
                with self.assertRaisesRegex(ValueError, "capture_id"):
                    pack_start_capture_response(Status.OK, 1, invalid)

        with self.assertRaisesRegex(ValueError, "capture_id"):
            unpack_start_capture_request(bytes.fromhex("01 00 00 00 00 00 00 00 00"))
        with self.assertRaisesRegex(ValueError, "capture_id"):
            unpack_start_capture_response(bytes.fromhex("00 01 00 00 00 00 00 00 00 00"))

    def test_cancel_capture_response_payload_vector(self):
        self.assertEqual(pack_cancel_capture_response(Status.OK), bytes.fromhex("00"))
        self.assertEqual(unpack_cancel_capture_response(bytes.fromhex("00")), Status.OK)

    def test_set_stream_request_and_response_payload_vectors(self):
        self.assertEqual(pack_set_stream_request(True, 100), bytes.fromhex("01 64 00"))
        self.assertEqual(unpack_set_stream_request(bytes.fromhex("01 64 00")), (True, 100))
        self.assertEqual(pack_set_stream_response(Status.OK, True, 100), bytes.fromhex("00 01 64 00"))
        self.assertEqual(unpack_set_stream_response(bytes.fromhex("00 01 64 00")), (Status.OK, True, 100))

    def test_telemetry_payload_vector(self):
        value = Telemetry(7, 1, 25.0, 38.857, 38.983, 0.328, 0.328)
        expected = bytes.fromhex("07 01 00 00 00 00 00 C8 41 91 6D 1B 42 98 EE 1B 42 9E EF A7 3E 9E EF A7 3E")
        self.assertEqual(pack_telemetry(value), expected)
        decoded = unpack_telemetry(expected)
        self.assertEqual((decoded.flags, decoded.sample_sequence), (7, 1))
        self.assertAlmostEqual(decoded.temperature_c, 25.0, places=6)
        self.assertAlmostEqual(decoded.humidity_raw, 38.857, places=5)
        self.assertAlmostEqual(decoded.humidity_corrected, 38.983, places=5)
        self.assertAlmostEqual(decoded.aw_unclamped, 0.328, places=6)
        self.assertAlmostEqual(decoded.aw_final, 0.328, places=6)

    def test_capture_progress_payload_vector(self):
        capture_id = 0x0102030405060708
        try:
            value = CaptureProgress(2, capture_id, 150, 15000, 71.577, 0.04)
        except TypeError as error:
            self.fail(f"capture_id progress schema is not implemented: {error}")
        expected = bytes.fromhex(
            "02 08 07 06 05 04 03 02 01 96 00 98 3A 00 00 "
            "6D 27 8F 42 0A D7 23 3D"
        )
        self.assertEqual(pack_capture_progress(value), expected)
        decoded = unpack_capture_progress(expected)
        self.assertEqual(
            (decoded.point_id, decoded.capture_id, decoded.sample_count, decoded.elapsed_ms),
            (2, capture_id, 150, 15000),
        )
        self.assertAlmostEqual(decoded.mean_rh_raw, 71.577, places=5)
        self.assertAlmostEqual(decoded.stddev_rh_raw, 0.04, places=6)

    def test_capture_result_payload_vector(self):
        capture_id = 0x0102030405060708
        value = CaptureResult(2, 0, capture_id, 150, 15000, 71.577, 72.25, 0.04)
        expected = bytes.fromhex(
            "02 00 08 07 06 05 04 03 02 01 96 00 98 3A 00 00 "
            "6D 27 8F 42 00 80 90 42 0A D7 23 3D"
        )
        self.assertEqual(pack_capture_result(value), expected)
        decoded = unpack_capture_result(expected)
        self.assertEqual(
            (decoded.point_id, decoded.result_code, decoded.capture_id, decoded.sample_count, decoded.elapsed_ms),
            (2, 0, capture_id, 150, 15000),
        )
        self.assertAlmostEqual(decoded.mean_rh_raw, 71.577, places=5)
        self.assertAlmostEqual(decoded.mean_rh_corrected, 72.25, places=5)
        self.assertAlmostEqual(decoded.stddev_rh_raw, 0.04, places=6)

    def test_capture_event_ids_must_be_nonzero_uint64(self):
        for invalid in (0, -1, 1 << 64, True):
            with self.subTest(codec="progress", invalid=invalid):
                with self.assertRaisesRegex(ValueError, "capture_id"):
                    pack_capture_progress(CaptureProgress(2, invalid, 150, 15000, 71.577, 0.04))
            with self.subTest(codec="result", invalid=invalid):
                with self.assertRaisesRegex(ValueError, "capture_id"):
                    pack_capture_result(CaptureResult(2, 0, invalid, 150, 15000, 71.577, 71.577, 0.04))

        zero_progress = bytearray(23)
        zero_progress[0] = 2
        with self.assertRaisesRegex(ValueError, "capture_id"):
            unpack_capture_progress(bytes(zero_progress))
        zero_result = bytearray(28)
        zero_result[0] = 2
        with self.assertRaisesRegex(ValueError, "capture_id"):
            unpack_capture_result(bytes(zero_result))

    def test_notice_payload_vector(self):
        self.assertEqual(pack_notice(Notice(2)), bytes.fromhex("02"))
        self.assertEqual(unpack_notice(bytes.fromhex("02")), Notice(2))

    def test_device_parameters_packer_requires_actual_bools(self):
        for params_valid, cal_dew_valid in ((1, False), (True, 0)):
            value = DeviceParameters(Status.OK, 1, params_valid, cal_dew_valid, 1.0, 0.0, 0.753)
            with self.subTest(params_valid=params_valid, cal_dew_valid=cal_dew_valid):
                with self.assertRaisesRegex(ValueError, "bool"):
                    pack_device_parameters(value)

    def test_device_info_packer_rejects_embedded_nul_and_unencodable_text(self):
        invalid_values = (
            DeviceInfo(Status.OK, "AW\0C6", "1.2.3"),
            DeviceInfo(Status.OK, "AW-C6", "1.2\0.3"),
            DeviceInfo(Status.OK, "\ud800", "1.2.3"),
        )
        for value in invalid_values:
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "NUL|UTF-8"):
                    pack_device_info(value)

    def test_device_parameters_round_trip(self):
        value = DeviceParameters(Status.OK, 42, True, False, 1.25, -2.5, 0.753)
        decoded = unpack_device_parameters(pack_device_parameters(value))
        self.assertEqual(decoded.status, value.status)
        self.assertEqual(decoded.param_version, value.param_version)
        self.assertEqual(decoded.params_valid, value.params_valid)
        self.assertEqual(decoded.cal_dew_valid, value.cal_dew_valid)
        self.assertAlmostEqual(decoded.slope_k, value.slope_k, places=6)
        self.assertAlmostEqual(decoded.offset_b, value.offset_b, places=6)
        self.assertAlmostEqual(decoded.cal_dew, value.cal_dew, places=6)

    def test_fixed_payload_codecs_require_exact_lengths(self):
        decoders = (
            (unpack_device_info, 37),
            (unpack_device_parameters, 17),
            (unpack_set_params_response, 17),
            (unpack_reset_params_response, 17),
            (unpack_set_params_request, 8),
            (unpack_start_capture_request, 9),
            (unpack_start_capture_response, 10),
            (unpack_cancel_capture_response, 1),
            (unpack_set_stream_request, 3),
            (unpack_set_stream_response, 4),
            (unpack_telemetry, 25),
            (unpack_capture_progress, 23),
            (unpack_capture_result, 28),
            (unpack_notice, 1),
        )
        for decoder, length in decoders:
            for invalid_length in (length - 1, length + 1):
                with self.subTest(decoder=decoder.__name__, length=invalid_length):
                    with self.assertRaisesRegex(ValueError, "length"):
                        decoder(bytes(invalid_length))

    def test_device_float_payloads_reject_non_finite_values(self):
        bad_params = bytearray(pack_device_parameters(DeviceParameters(Status.OK, 1, True, True, 1.0, 0.0, 0.753)))
        bad_params[5:9] = bytes.fromhex("00 00 C0 7F")
        with self.assertRaisesRegex(ValueError, "finite"):
            unpack_device_parameters(bytes(bad_params))

        bad_telemetry = bytearray(pack_telemetry(Telemetry(7, 1, 25.0, 38.0, 38.1, 0.3, 0.3)))
        bad_telemetry[5:9] = bytes.fromhex("00 00 80 7F")
        with self.assertRaisesRegex(ValueError, "finite"):
            unpack_telemetry(bytes(bad_telemetry))

        capture_id = 0x0102030405060708
        bad_progress = bytearray(pack_capture_progress(CaptureProgress(2, capture_id, 150, 15000, 71.577, 0.04)))
        bad_progress[15:19] = bytes.fromhex("00 00 80 7F")
        with self.assertRaisesRegex(ValueError, "finite"):
            unpack_capture_progress(bytes(bad_progress))

        bad_result = bytearray(pack_capture_result(CaptureResult(2, 0, capture_id, 150, 15000, 71.577, 71.577, 0.04)))
        bad_result[16:20] = bytes.fromhex("00 00 C0 7F")
        with self.assertRaisesRegex(ValueError, "finite"):
            unpack_capture_result(bytes(bad_result))

        self.assertFalse(math.isfinite(float("nan")))


if __name__ == "__main__":
    unittest.main()
