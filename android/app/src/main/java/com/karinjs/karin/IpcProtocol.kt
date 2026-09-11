package com.karinjs.karin

import java.io.ByteArrayOutputStream

/**
 * App 与容器内 karin-ipc 守护进程之间的二进制帧协议（大端序），
 * 与 android/app/src/main/cpp/karin-ipc.c 头部注释保持一致：
 *
 *   每帧: u32 payloadLen | payload
 *   App -> 守护进程:
 *     u8 type=1 EXEC: u16 idLen | id | u32 cmdLen | cmd | u8 flags(bit0=保留 stdin 管道)
 *     u8 type=2 KILL: u16 idLen | id
 *     u8 type=3 QUIT: 无
 *     u8 type=4 WRITE: u16 idLen | id | u32 dataLen | data
 *   守护进程 -> App:
 *     u8 type=1 OUT:   u16 idLen | id | u8 stream(1=stdout,2=stderr) | u32 dataLen | data
 *     u8 type=2 EXIT:  u16 idLen | id | u32 code
 *     u8 type=3 READY: 无
 */
internal object IpcProtocol {
  const val REQ_EXEC = 1
  const val REQ_KILL = 2
  const val REQ_QUIT = 3
  const val REQ_WRITE = 4
  const val EXEC_FLAG_STDIN = 1
  const val RESP_OUT = 1
  const val RESP_EXIT = 2
  const val RESP_READY = 3
  const val STREAM_STDERR = 2
  const val MAX_FRAME = 8 * 1024 * 1024
  const val MAX_COMMAND = 1024 * 1024
  const val MAX_DAEMON_STDERR = 4096
}

/** 大端序帧体写入器。 */
internal class FrameWriter {
  private val buffer = ByteArrayOutputStream()
  fun u8(value: Int) = apply { buffer.write(value and 0xff) }
  fun u16(value: Int) = apply {
    buffer.write((value ushr 8) and 0xff)
    buffer.write(value and 0xff)
  }
  fun u32(value: Int) = apply {
    buffer.write((value ushr 24) and 0xff)
    buffer.write((value ushr 16) and 0xff)
    buffer.write((value ushr 8) and 0xff)
    buffer.write(value and 0xff)
  }
  fun bytes(value: ByteArray) = apply { buffer.write(value) }
  fun toByteArray(): ByteArray = buffer.toByteArray()
}

/** 大端序帧体读取器；数据不足时抛 IllegalStateException。 */
internal class FrameReader(private val payload: ByteArray) {
  private var offset = 0
  fun u8(): Int {
    if (offset + 1 > payload.size) throw IllegalStateException("帧数据不足")
    return payload[offset++].toInt() and 0xff
  }
  fun u16(): Int {
    if (offset + 2 > payload.size) throw IllegalStateException("帧数据不足")
    val value = ((payload[offset].toInt() and 0xff) shl 8) or (payload[offset + 1].toInt() and 0xff)
    offset += 2
    return value
  }
  fun u32(): Int {
    if (offset + 4 > payload.size) throw IllegalStateException("帧数据不足")
    val value = ((payload[offset].toInt() and 0xff) shl 24) or
      ((payload[offset + 1].toInt() and 0xff) shl 16) or
      ((payload[offset + 2].toInt() and 0xff) shl 8) or
      (payload[offset + 3].toInt() and 0xff)
    offset += 4
    return value
  }
  fun bytes(length: Int): ByteArray {
    if (offset + length > payload.size) throw IllegalStateException("帧数据不足")
    val value = payload.copyOfRange(offset, offset + length)
    offset += length
    return value
  }
  fun string16(): String {
    val length = u16()
    return String(bytes(length), Charsets.UTF_8)
  }
  fun bytes32(): ByteArray = bytes(u32())
}
