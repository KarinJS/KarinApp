package com.karinjs.karin

import android.system.Os
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.tukaani.xz.XZInputStream

/**
 * 管理唯一的 proot 容器。容器内运行 karin-ipc 守护进程，App 与守护进程通过
 * stdin/stdout 上的大端二进制帧通信（协议见 android/app/src/main/cpp/karin-ipc.c）。
 * 每条命令在容器内作为守护进程的子进程运行，支持并发与单独 kill。
 */
class ProotModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private val lock = Any()
  @Volatile private var keeperProcess: Process? = null
  private var keeperWriter: DataOutputStream? = null
  private var commandCounter = 0L

  override fun getName() = "KarinProot"

  @ReactMethod
  fun initialize(promise: Promise) = runAsync(promise, "CONTAINER_INIT_FAILED") {
    ensureContainer()
    "ready"
  }

  /** 启动唯一的 proot 容器，容器内运行 karin-ipc 守护进程，等待 READY 握手。 */
  @ReactMethod
  fun start(promise: Promise) = runAsync(promise, "PROOT_START_FAILED") {
    synchronized(lock) {
      if (keeperProcess?.isAlive == true) return@runAsync "running"
      val root = ensureContainer()
      prepareRuntime(root)
      val probe = createGuestProcess(listOf("/bin/sh", "-c", "test -r /etc/os-release && test -x /bin/sh && test -x /usr/local/bin/karin-ipc"), true)
      if (!probe.waitFor(10, TimeUnit.SECONDS)) {
        probe.destroyForcibly()
        throw IllegalStateException("proot 自检超时")
      }
      val probeOutput = probe.inputStream.bufferedReader().readText().trim()
      if (probe.exitValue() != 0) {
        throw IllegalStateException("proot 自检失败（退出码 ${probe.exitValue()}）${detail(probeOutput)}")
      }
      val started = createGuestProcess(listOf("/usr/local/bin/karin-ipc"), false)
      val ready = CountDownLatch(1)
      keeperProcess = started
      keeperWriter = DataOutputStream(BufferedOutputStream(started.outputStream))
      drainKeeper(started, ready)
      if (!ready.await(15, TimeUnit.SECONDS)) {
        terminate(started)
        synchronized(lock) {
          if (keeperProcess === started) {
            keeperProcess = null
            keeperWriter = null
          }
        }
        throw IllegalStateException("容器守护进程启动超时")
      }
      "running"
    }
  }

  @ReactMethod
  fun stop(force: Boolean, promise: Promise) = runAsync(promise, "PROOT_STOP_FAILED") {
    val keeper: Process?
    synchronized(lock) {
      keeper = keeperProcess
      keeperProcess = null
      val writer = keeperWriter
      keeperWriter = null
      if (!force) {
        runCatching { writer?.let { sendFrameLocked(it, FrameWriter().u8(REQ_QUIT).toByteArray()) } }
      }
    }
    if (!force && keeper != null && !keeper.waitFor(4, TimeUnit.SECONDS)) terminate(keeper)
    else keeper?.let(::terminate)
    "stopped"
  }

  @ReactMethod
  fun status(promise: Promise) = promise.resolve(if (keeperProcess?.isAlive == true) "running" else "stopped")

  @ReactMethod
  fun execute(command: String, commandId: String, promise: Promise) {
    val id = if (commandId.isBlank()) synchronized(lock) { (++commandCounter).toString() } else commandId
    val idBytes = id.toByteArray(Charsets.UTF_8)
    val cmdBytes = command.toByteArray(Charsets.UTF_8)
    if (cmdBytes.size > MAX_COMMAND) {
      promise.reject("PROOT_COMMAND_FAILED", IllegalStateException("命令过长"))
      return
    }
    try {
      val frame = FrameWriter().u8(REQ_EXEC).u16(idBytes.size).bytes(idBytes).u32(cmdBytes.size).bytes(cmdBytes).toByteArray()
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
      val frame = FrameWriter().u8(REQ_KILL).u16(idBytes.size).bytes(idBytes).toByteArray()
      synchronized(lock) { sendFrameLocked(keeperWriter ?: throw IllegalStateException("proot 容器未运行"), frame) }
      promise.resolve(commandId)
    } catch (error: Exception) {
      promise.reject("PROOT_KILL_FAILED", error)
    }
  }

  @ReactMethod fun addListener(eventName: String) = Unit
  @ReactMethod fun removeListeners(count: Int) = Unit

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
          if (length < 0 || length > MAX_FRAME) throw IllegalStateException("非法帧长度 $length")
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

  private fun dispatchFrame(payload: ByteArray, ready: CountDownLatch) {
    try {
      val reader = FrameReader(payload)
      when (reader.u8()) {
        RESP_READY -> ready.countDown()
        RESP_OUT -> {
          val id = reader.string16()
          val stream = if (reader.u8() == STREAM_STDERR) "stderr" else "stdout"
          val data = String(reader.bytes32(), Charsets.UTF_8)
          emitCommand(id, stream, data)
        }
        RESP_EXIT -> {
          val id = reader.string16()
          val code = reader.u32()
          emitCommand(id, "exit", "", code)
        }
      }
    } catch (_: Exception) {
      // 忽略损坏帧，继续等待下一帧
    }
  }

  private fun createGuestProcess(command: List<String>, mergeError: Boolean): Process {
    val root = ensureContainer()
    val argv = buildProotArgv(root).apply { addAll(command) }
    return ProcessBuilder(argv).apply {
      redirectErrorStream(mergeError)
      environment().apply {
        put("PROOT_LOADER", loaderFile().absolutePath)
        put("PROOT_TMP_DIR", runtimeTmpDir().absolutePath)
        put("LD_LIBRARY_PATH", "${runtimeLibDir().absolutePath}:${nativeDir().absolutePath}")
        put("PROOT_NO_SECCOMP", "1")
        if (!hardlinkSupported(root)) put("PROOT_L2S_DIR", File(root, ".l2s").apply { mkdirs() }.absolutePath)
        put("HOME", "/root")
        put("USER", "root")
        put("LOGNAME", "root")
        put("SHELL", "/bin/sh")
        put("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
        put("TMPDIR", "/tmp")
        put("LANG", "C.UTF-8")
        put("DEBIAN_FRONTEND", "noninteractive")
      }
    }.start()
  }

  private fun buildProotArgv(root: File): MutableList<String> = mutableListOf<String>().apply {
    add(prootFile().absolutePath)
    if (!hardlinkSupported(root)) add("--link2symlink")
    add("-L")
    add("--kill-on-exit")
    add("-0")
    add("--rootfs=${root.absolutePath}")
    add("--cwd=/root")
    listOf("/dev" to "/dev", "/dev/urandom" to "/dev/random", "/proc" to "/proc", "/sys" to "/sys", "/proc/self/fd" to "/dev/fd")
      .filter { File(it.first).exists() }
      .forEach { (host, guest) -> add("-b"); add("$host:$guest") }
  }

  private fun prepareRuntime(root: File) {
    runtimeTmpDir().mkdirs()
    val libDir = runtimeLibDir().apply { mkdirs() }
    mapOf("libtalloc.so.2" to File(nativeDir(), "libtalloc.so"), "libandroid-shmem.so" to File(nativeDir(), "libandroid-shmem.so"))
      .forEach { (name, source) ->
        if (!source.isFile) throw IllegalStateException("安装包中缺少 ${source.name}")
        val target = File(libDir, name)
        if (!target.isFile || target.length() != source.length()) source.copyTo(target, overwrite = true)
      }
    if (!prootFile().isFile) throw IllegalStateException("安装包中缺少 proot 主程序")
    if (!loaderFile().isFile) throw IllegalStateException("安装包中缺少 proot loader")
    installDaemon(root)
  }

  /** 把 karin-ipc 静态可执行文件复制进容器 /usr/local/bin，容器启动时直接运行。 */
  private fun installDaemon(root: File) {
    val source = File(nativeDir(), "libkarin_ipc.so")
    if (!source.isFile) throw IllegalStateException("安装包中缺少 IPC 守护进程")
    val target = File(root, "usr/local/bin/karin-ipc")
    if (!target.isFile || target.length() != source.length()) {
      target.parentFile?.mkdirs()
      source.copyTo(target, overwrite = true)
      chmod(target, 0x1ed) // 0755
    }
  }

  private fun hardlinkSupported(root: File): Boolean {
    hardlinkSupport?.let { return it }
    synchronized(lock) {
      hardlinkSupport?.let { return it }
      val source = File(root, ".karin-link-probe")
      val link = File(root, ".karin-link-probe-link")
      val supported = try {
        source.writeText("ok")
        java.nio.file.Files.createLink(link.toPath(), source.toPath())
        link.readText() == "ok"
      } catch (_: Exception) { false } finally { source.delete(); link.delete() }
      hardlinkSupport = supported
      return supported
    }
  }

  private fun ensureContainer(): File {
    val root = File(context.filesDir, "debian-rootfs")
    val marker = File(root, ".karin-ready")
    val required = listOf("etc/os-release", "bin/sh", "usr/bin/env")
    if (marker.isFile && required.all { File(root, it).isFile }) return root
    synchronized(extractLock) {
      if (marker.isFile && required.all { File(root, it).isFile }) return root
      if (root.exists() && !root.deleteRecursively()) throw IllegalStateException("无法清理未完成的容器目录")
      if (!root.mkdirs()) throw IllegalStateException("无法创建容器目录")
      val archive = File(context.cacheDir, "debian.tar.xz")
      try {
        context.assets.open("container/debian-bookworm-arm64.tar.xz").use { input -> FileOutputStream(archive).use { output -> input.copyTo(output) } }
        extractRootfs(archive, root)
      } catch (error: Exception) {
        root.deleteRecursively()
        throw error
      } finally { archive.delete() }
      if (!required.all { File(root, it).isFile }) throw IllegalStateException("容器初始化不完整")
      File(root, "tmp").apply { mkdirs(); chmod(this, 0x1ff) }
      File(root, "root").mkdirs()
      marker.writeText("debian-bookworm-arm64-v2\n")
      return root
    }
  }

  private fun extractRootfs(archive: File, root: File) {
    val pendingLinks = mutableListOf<Triple<File, File, Int>>()
    val rootPath = root.canonicalFile.toPath()
    XZInputStream(archive.inputStream().buffered()).use { xz ->
      TarArchiveInputStream(xz).use { tar ->
        var entry: TarArchiveEntry? = tar.nextEntry
        while (entry != null) {
          val current = entry
          if (current.name == "." || current.name == "./") {
            entry = tar.nextEntry
            continue
          }
          try {
            // Do not use canonicalFile here: it follows links already extracted from the archive
            // (for example usr/bin/perl -> perl5.36.0) and makes valid entries escape the root.
            val target = safeTarget(rootPath, current.name)
            when {
              current.isDirectory -> target.mkdirs()
              current.isSymbolicLink -> { target.parentFile?.mkdirs(); java.nio.file.Files.createSymbolicLink(target.toPath(), java.nio.file.Paths.get(current.linkName)) }
              current.isLink -> pendingLinks += Triple(target, safeTarget(rootPath, current.linkName), current.mode)
              current.isFile -> { target.parentFile?.mkdirs(); FileOutputStream(target).use { tar.copyTo(it) } }
            }
            if (!current.isSymbolicLink && !current.isLink && target.exists()) chmod(target, current.mode)
          } catch (error: Exception) {
            throw IllegalStateException(
              "解包条目失败: name=${current.name}, link=${current.linkName}, cause=${error.javaClass.simpleName}: ${error.message ?: "无详细信息"}",
              error,
            )
          }
          entry = tar.nextEntry
        }
      }
    }
    pendingLinks.forEach { (link, source, mode) ->
      if (!source.exists()) throw IllegalStateException("镜像硬链接目标不存在: ${source.path}")
      link.parentFile?.mkdirs()
      try {
        java.nio.file.Files.createLink(link.toPath(), source.toPath())
      } catch (error: Exception) {
        // 部分 Android 文件系统/内核不允许创建硬链接，退化为复制文件内容
        if (!source.isFile) throw error
        source.copyTo(link, overwrite = true)
        chmod(link, mode)
      }
    }
  }

  private fun safeTarget(rootPath: java.nio.file.Path, name: String): File {
    val relative = java.nio.file.Paths.get(name).normalize()
    if (relative.isAbsolute || relative.startsWith("..")) throw IllegalStateException("镜像包含非法路径: $name")
    val target = rootPath.resolve(relative).normalize()
    if (!target.startsWith(rootPath)) throw IllegalStateException("镜像包含非法路径: $name")
    return target.toFile()
  }

  private fun chmod(file: File, mode: Int) {
    try { Os.chmod(file.absolutePath, mode and 0x1ff) } catch (_: Exception) {
      file.setReadable(mode and 0x124 != 0, false); file.setWritable(mode and 0x92 != 0, false); file.setExecutable(mode and 0x49 != 0, false)
    }
  }

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

  private fun <T> runAsync(promise: Promise, code: String, block: () -> T) {
    Thread { try { promise.resolve(block()) } catch (error: Exception) { promise.reject(code, error) } }
      .apply { isDaemon = true; name = "karin-proot-native" }.start()
  }

  private fun nativeDir() = File(context.applicationInfo.nativeLibraryDir)
  private fun prootFile() = File(nativeDir(), "libproot.so")
  private fun loaderFile() = File(nativeDir(), "libproot-loader.so")
  private fun runtimeLibDir() = File(context.filesDir, "proot-runtime/lib")
  private fun runtimeTmpDir() = File(context.cacheDir, "proot-tmp")
  private fun detail(output: String) = if (output.isBlank()) "" else ": $output"

  private class FrameWriter {
    private val buffer = java.io.ByteArrayOutputStream()
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
    fun toByteArray() = buffer.toByteArray()
  }

  private class FrameReader(private val payload: ByteArray) {
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

  companion object {
    private const val REQ_EXEC = 1
    private const val REQ_KILL = 2
    private const val REQ_QUIT = 3
    private const val RESP_OUT = 1
    private const val RESP_EXIT = 2
    private const val RESP_READY = 3
    private const val STREAM_STDOUT = 1
    private const val STREAM_STDERR = 2
    private const val MAX_FRAME = 8 * 1024 * 1024
    private const val MAX_COMMAND = 1024 * 1024
    private val extractLock = Any()
    @Volatile private var hardlinkSupport: Boolean? = null
  }
}
