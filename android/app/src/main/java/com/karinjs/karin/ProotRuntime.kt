package com.karinjs.karin

import android.content.Context
import java.io.File
import java.nio.file.Files
import java.nio.file.Paths
import java.util.TimeZone

/**
 * 准备 proot 运行环境（拷贝依赖 so、安装容器内 karin-ipc 守护进程），
 * 并负责组装 proot 命令行与环境变量、拉起容器内进程。
 */
internal class ProotRuntime(private val context: Context) {

  private fun nativeDir() = File(context.applicationInfo.nativeLibraryDir)
  private fun prootFile() = File(nativeDir(), "libproot.so")
  private fun loaderFile() = File(nativeDir(), "libproot-loader.so")
  private fun runtimeLibDir() = File(context.filesDir, "proot-runtime/lib")
  private fun runtimeTmpDir() = File(context.cacheDir, "proot-tmp")

  /** 校验并准备 proot 依赖：运行库目录、karin-ipc 守护进程。 */
  fun prepareRuntime(root: File) {
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
    syncTimeZone(root)
  }

  /** 在容器内启动一个进程（mergeError=true 时 stderr 合并进 stdout，用于自检）。 */
  fun createGuestProcess(root: File, command: List<String>, mergeError: Boolean): Process {
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
        put("TZ", deviceTimeZone(root))
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

  /**
   * 把设备时区写进容器（/etc/localtime 软链 + /etc/timezone），
   * 让不读 TZ 环境变量的程序（如部分读 /etc/timezone 的库）也能拿到本地时间。
   * 偏移写法的时区没有对应 zone 文件，此时只靠 TZ 环境变量。失败不阻塞启动。
   */
  private fun syncTimeZone(root: File) {
    runCatching {
      val id = TimeZone.getDefault().id
      if (!File(root, "usr/share/zoneinfo/$id").isFile) return@runCatching
      val localtime = File(root, "etc/localtime")
      Files.deleteIfExists(localtime.toPath())
      Files.createSymbolicLink(localtime.toPath(), Paths.get("/usr/share/zoneinfo/$id"))
      File(root, "etc/timezone").writeText("$id\n")
    }
  }

  /** 设备时区名；rootfs 没有对应 zoneinfo（如手动设 GMT+08:00 偏移的设备）时退回 POSIX 偏移写法。 */
  private fun deviceTimeZone(root: File): String {
    val zone = TimeZone.getDefault()
    if (File(root, "usr/share/zoneinfo/${zone.id}").isFile) return zone.id
    val minutes = zone.rawOffset / 60_000
    if (minutes == 0) return "UTC"
    // POSIX 时区偏移符号与 UTC 相反：GMT-8 表示 UTC+8
    val sign = if (minutes > 0) '-' else '+'
    val absolute = Math.abs(minutes)
    return buildString {
      append("GMT").append(sign).append(absolute / 60)
      if (absolute % 60 != 0) append(':').append("%02d".format(absolute % 60))
    }
  }

  /** 探测容器目录所在文件系统是否支持硬链接；不支持时 proot 需要 --link2symlink。结果只探测一次并缓存。 */
  private fun hardlinkSupported(root: File): Boolean {
    hardlinkSupport?.let { return it }
    synchronized(this) {
      hardlinkSupport?.let { return it }
      val source = File(root, ".karin-link-probe")
      val link = File(root, ".karin-link-probe-link")
      val supported = try {
        source.writeText("ok")
        Files.createLink(link.toPath(), source.toPath())
        link.readText() == "ok"
      } catch (_: Exception) { false } finally { source.delete(); link.delete() }
      hardlinkSupport = supported
      return supported
    }
  }

  /** 清除硬链接探测缓存；容器重置后需对新解包的 rootfs 重新探测。 */
  internal fun clearHardlinkCache() {
    hardlinkSupport = null
  }

  private companion object {
    @Volatile var hardlinkSupport: Boolean? = null
  }
}
