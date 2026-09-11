package com.karinjs.karin

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import android.os.Build
import android.system.Os
import android.system.OsConstants
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * React Native 桥接层：管理唯一的 proot 容器会话。
 *
 * 职责划分：
 * - [RootfsInstaller]：解包 debian rootfs；
 * - [ProotRuntime]：准备 proot 运行环境并拉起容器内进程；
 * - 本类：容器内 karin-ipc 守护进程的生命周期，以及 stdin/stdout 上的
 *   二进制帧收发（协议见 [IpcProtocol]，与 cpp/karin-ipc.c 对应）。
 *
 * 每条命令在容器内作为守护进程的子进程运行，支持并发与单独 kill。
 */
class ProotModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val rootfs = RootfsInstaller(context)
  private val runtime = ProotRuntime(context)

  private val lock = Any()
  @Volatile private var keeperProcess: Process? = null
  private var keeperWriter: DataOutputStream? = null
  private var commandCounter = 0L

  override fun getName() = "KarinProot"

  @ReactMethod
  fun initialize(promise: Promise) = runAsync(promise, "CONTAINER_INIT_FAILED") {
    rootfs.ensureContainer()
    "ready"
  }

  /** 启动唯一的 proot 容器，容器内运行 karin-ipc 守护进程，等待 READY 握手。 */
  @ReactMethod
  fun start(promise: Promise) = runAsync(promise, "PROOT_START_FAILED") {
    synchronized(lock) {
      if (keeperProcess?.isAlive == true) return@runAsync "running"
      val root = rootfs.ensureContainer()
      runtime.prepareRuntime(root)
      probeGuest(root)
      val started = runtime.createGuestProcess(root, listOf("/usr/local/bin/karin-ipc"), false)
      val ready = CountDownLatch(1)
      keeperProcess = started
      keeperWriter = DataOutputStream(BufferedOutputStream(started.outputStream))
      drainKeeper(started, ready)
      val stderrLog = StringBuffer()
      drainDaemonStderr(started, stderrLog)
      if (!ready.await(15, TimeUnit.SECONDS)) {
        terminate(started)
        synchronized(lock) {
          if (keeperProcess === started) {
            keeperProcess = null
            keeperWriter = null
          }
        }
        throw IllegalStateException("容器守护进程启动超时${detail(stderrLog.toString().trim())}")
      }
      "running"
    }
  }

  /** 自检：容器内 /etc/os-release 可读、/bin/sh 与 karin-ipc 可执行。 */
  private fun probeGuest(root: java.io.File) {
    val probe = runtime.createGuestProcess(root, listOf("/bin/sh", "-c", "test -r /etc/os-release && test -x /bin/sh && test -x /usr/local/bin/karin-ipc"), true)
    if (!probe.waitFor(10, TimeUnit.SECONDS)) {
      probe.destroyForcibly()
      throw IllegalStateException("proot 自检超时")
    }
    val probeOutput = probe.inputStream.bufferedReader().readText().trim()
    if (probe.exitValue() != 0) {
      throw IllegalStateException("proot 自检失败（退出码 ${probe.exitValue()}）${detail(probeOutput)}")
    }
  }

  @ReactMethod
  fun stop(force: Boolean, promise: Promise) = runAsync(promise, "PROOT_STOP_FAILED") {
    stopKeeper(force)
    "stopped"
  }

  /** 重置容器：强制终止 keeper 进程，删除已解包的 rootfs，下次启动重新解包。 */
  @ReactMethod
  fun reset(promise: Promise) = runAsync(promise, "PROOT_RESET_FAILED") {
    stopKeeper(true)
    // proot 被强杀时 tracee 不会跟着退出，删除目录前先清掉仍占用 rootfs 的残留进程。
    killProcessesUsing(rootfs.rootDir())
    rootfs.reset()
    runtime.clearHardlinkCache()
    "reset"
  }

  @ReactMethod
  fun status(promise: Promise) = promise.resolve(if (keeperProcess?.isAlive == true) "running" else "stopped")

  @ReactMethod
  fun startForegroundService(promise: Promise) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(
        android.content.Intent(context, KarinForegroundService::class.java),
      ) else context.startService(android.content.Intent(context, KarinForegroundService::class.java))
      promise.resolve("started")
    } catch (error: Exception) {
      promise.reject("FOREGROUND_SERVICE_START_FAILED", error)
    }
  }

  @ReactMethod
  fun stopForegroundService(promise: Promise) {
    try {
      context.stopService(android.content.Intent(context, KarinForegroundService::class.java))
      promise.resolve("stopped")
    } catch (error: Exception) {
      promise.reject("FOREGROUND_SERVICE_STOP_FAILED", error)
    }
  }

  /**
   * 在容器内执行命令。interactive=true 时守护进程为子进程保留一条 stdin 管道，
   * 之后可用 [write] 向它发送数据（node-karin 的控制台输入读 process.stdin）。
   */
  @ReactMethod
  fun execute(command: String, commandId: String, interactive: Boolean, promise: Promise) {
    val id = if (commandId.isBlank()) synchronized(lock) { (++commandCounter).toString() } else commandId
    val idBytes = id.toByteArray(Charsets.UTF_8)
    val cmdBytes = command.toByteArray(Charsets.UTF_8)
    if (cmdBytes.size > IpcProtocol.MAX_COMMAND) {
      promise.reject("PROOT_COMMAND_FAILED", IllegalStateException("命令过长"))
      return
    }
    try {
      val writer = FrameWriter().u8(IpcProtocol.REQ_EXEC).u16(idBytes.size).bytes(idBytes).u32(cmdBytes.size).bytes(cmdBytes)
      if (interactive) writer.u8(IpcProtocol.EXEC_FLAG_STDIN)
      val frame = writer.toByteArray()
      synchronized(lock) { sendFrameLocked(keeperWriter ?: throw IllegalStateException("proot 容器未运行"), frame) }
      promise.resolve(id)
    } catch (error: Exception) {
      promise.reject("PROOT_COMMAND_FAILED", error)
    }
  }

  /** 终止容器内指定 commandId 的进程（发 KILL 帧，守护进程对整个进程组 killpg）。 */
  @ReactMethod
  fun kill(commandId: String, promise: Promise) {
    val idBytes = commandId.toByteArray(Charsets.UTF_8)
    try {
      val frame = FrameWriter().u8(IpcProtocol.REQ_KILL).u16(idBytes.size).bytes(idBytes).toByteArray()
      synchronized(lock) { sendFrameLocked(keeperWriter ?: throw IllegalStateException("proot 容器未运行"), frame) }
      promise.resolve(commandId)
    } catch (error: Exception) {
      promise.reject("PROOT_KILL_FAILED", error)
    }
  }

  /** 向 interactive 命令的 stdin 写入原始字节（不做 shell 转义），仅该命令可读。 */
  @ReactMethod
  fun write(commandId: String, data: String, promise: Promise) {
    val idBytes = commandId.toByteArray(Charsets.UTF_8)
    val dataBytes = data.toByteArray(Charsets.UTF_8)
    if (idBytes.size > 0xffff) {
      promise.reject("PROOT_WRITE_FAILED", IllegalStateException("命令 ID 过长"))
      return
    }
    try {
      val frame = FrameWriter().u8(IpcProtocol.REQ_WRITE).u16(idBytes.size).bytes(idBytes).u32(dataBytes.size).bytes(dataBytes).toByteArray()
      synchronized(lock) { sendFrameLocked(keeperWriter ?: throw IllegalStateException("proot 容器未运行"), frame) }
      promise.resolve(commandId)
    } catch (error: Exception) {
      promise.reject("PROOT_WRITE_FAILED", error)
    }
  }

  @ReactMethod fun addListener(eventName: String) = Unit
  @ReactMethod fun removeListeners(count: Int) = Unit

  // ---- 帧收发 ----

  private fun sendFrameLocked(writer: DataOutputStream, payload: ByteArray) {
    writer.writeInt(payload.size)
    writer.write(payload)
    writer.flush()
  }

  /** 读取守护进程的帧流：READY 握手、stdout/stderr 输出、exit 退出码。 */
  private fun drainKeeper(process: Process, ready: CountDownLatch) {
    Thread {
      try {
        val input = DataInputStream(process.inputStream)
        while (true) {
          val length = input.readInt()
          if (length < 0 || length > IpcProtocol.MAX_FRAME) throw IllegalStateException("非法帧长度 $length")
          val payload = ByteArray(length)
          input.readFully(payload)
          dispatchFrame(payload, ready)
        }
      } catch (_: Exception) {
        // EOF 或协议错误：容器已停止
      } finally {
        try { process.waitFor() } catch (_: InterruptedException) {}
        synchronized(lock) {
          if (keeperProcess === process) {
            keeperProcess = null
            keeperWriter = null
          }
        }
      }
    }.apply { name = "karin-proot-keeper"; isDaemon = true }.start()
  }

  /** 持续读取守护进程 stderr，供启动失败时输出诊断（正常运行时内容为空）。 */
  private fun drainDaemonStderr(process: Process, buffer: StringBuffer) {
    Thread {
      try {
        process.errorStream.bufferedReader().forEachLine { line -> if (buffer.length < IpcProtocol.MAX_DAEMON_STDERR) buffer.append(line).append('\n') }
      } catch (_: Exception) {
        // EOF 或读取失败：守护进程已退出
      }
    }.apply { name = "karin-proot-stderr"; isDaemon = true }.start()
  }

  private fun dispatchFrame(payload: ByteArray, ready: CountDownLatch) {
    try {
      val reader = FrameReader(payload)
      when (reader.u8()) {
        IpcProtocol.RESP_READY -> ready.countDown()
        IpcProtocol.RESP_OUT -> {
          val id = reader.string16()
          val stream = if (reader.u8() == IpcProtocol.STREAM_STDERR) "stderr" else "stdout"
          val data = String(reader.bytes32(), Charsets.UTF_8)
          emitCommand(id, stream, data)
        }
        IpcProtocol.RESP_EXIT -> {
          val id = reader.string16()
          val code = reader.u32()
          emitCommand(id, "exit", "", code)
        }
      }
    } catch (_: Exception) {
      // 忽略损坏帧，继续等待下一帧
    }
  }

  // ---- 工具 ----

  private fun emitCommand(id: String, stream: String, data: String, exitCode: Int? = null) {
    if (!context.hasActiveReactInstance()) return
    val event = Arguments.createMap().apply { putString("commandId", id); putString("stream", stream); putString("data", data); exitCode?.let { putInt("exitCode", it) } }
    context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("KarinProotCommand", event)
  }

  private fun terminate(process: Process) {
    if (!process.isAlive) return
    process.destroy()
    if (!process.waitFor(2, TimeUnit.SECONDS)) { process.destroyForcibly(); process.waitFor(2, TimeUnit.SECONDS) }
  }

  /**
   * 停止 keeper 进程（proot）。容器内守护进程的 stdin 就是 keeper 的 stdin 管道：关闭它会让
   * 守护进程读到 EOF 后杀掉所有子进程并退出，proot 随之正常退出并回收 tracee；force 时不再等待。
   */
  private fun stopKeeper(force: Boolean) {
    val keeper: Process?
    val writer: DataOutputStream?
    synchronized(lock) {
      keeper = keeperProcess
      writer = keeperWriter
      keeperProcess = null
      keeperWriter = null
    }
    if (keeper == null) {
      runCatching { writer?.close() }
      return
    }
    if (!force) {
      runCatching { writer?.let { sendFrameLocked(it, FrameWriter().u8(IpcProtocol.REQ_QUIT).toByteArray()) } }
    }
    // 关闭 stdin：即使 QUIT 帧丢失，守护进程读到 EOF 后也会杀掉子进程并退出。
    runCatching { writer?.close() }
    if (!force && keeper.waitFor(GRACEFUL_STOP_TIMEOUT_MS, TimeUnit.MILLISECONDS)) return
    terminate(keeper)
    keeper.waitFor(FORCE_STOP_TIMEOUT_MS, TimeUnit.MILLISECONDS)
  }

  /**
   * 兜底：强杀所有以容器目录（含子目录）为工作目录的进程。
   *
   * proot 被强杀时 tracee 不会跟着退出；只要还有进程以 rootfs 内的目录为工作目录，
   * 删除容器目录就会失败，所以删除前先把它们清掉。
   */
  private fun killProcessesUsing(root: java.io.File) {
    val pids = pidsWithCwdUnder(root)
    pids.forEach { pid -> runCatching { Os.kill(pid, OsConstants.SIGKILL) } }
    val deadline = System.currentTimeMillis() + FORCE_STOP_TIMEOUT_MS
    while (pidsWithCwdUnder(root).isNotEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(50)
  }

  /** 找出工作目录位于 rootfs 内（含 rootfs 自身）的同 UID 进程 pid。 */
  private fun pidsWithCwdUnder(root: java.io.File): List<Int> {
    val rootPath = root.absolutePath.trimEnd('/')
    return java.io.File("/proc").listFiles()?.mapNotNull { entry ->
      entry.name.toIntOrNull()?.takeIf { pid ->
        val cwd = try { java.io.File("/proc/$pid/cwd").canonicalPath } catch (_: Exception) { return@takeIf false }
        cwd == rootPath || cwd.startsWith("$rootPath/")
      }
    } ?: emptyList()
  }

  private fun <T> runAsync(promise: Promise, code: String, block: () -> T) {
    Thread { try { promise.resolve(block()) } catch (error: Exception) { promise.reject(code, error) } }
      .apply { isDaemon = true; name = "karin-proot-native" }.start()
  }

  private fun detail(output: String) = if (output.isBlank()) "" else ": $output"

  private companion object {
    /** 非强制停止时等待容器内进程自行退出的时间。 */
    const val GRACEFUL_STOP_TIMEOUT_MS = 4000L
    /** 强杀后等待进程退出的最长时间。 */
    const val FORCE_STOP_TIMEOUT_MS = 2000L
  }
}
