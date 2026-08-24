package com.karinjs.karin

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileOutputStream
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.tukaani.xz.XZInputStream

/** proot 容器进程管理：负责 debian 容器根文件系统解压与容器进程的启停。 */
class ProotModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  private var process: Process? = null
  override fun getName() = "KarinProot"

  @ReactMethod
  fun start(promise: Promise) {
    try {
      if (process?.isAlive == true) { promise.resolve("running"); return }
      val root = File(context.filesDir, "debian-rootfs")
      if (!File(root, "etc/os-release").exists()) {
        root.mkdirs()
        val archive = File(context.cacheDir, "debian.tar.xz")
        copyAsset("container/debian-bookworm-arm64.tar.xz", archive)
        extractRootfs(archive, root)
        archive.delete()
      }
      val nativeDir = context.applicationInfo.nativeLibraryDir
      val prootFile = File(nativeDir, "libproot.so")
      val loaderFile = File(nativeDir, "libproot-loader.so")
      if (!prootFile.exists()) throw IllegalStateException("安装包中缺少 proot 主程序")
      if (!loaderFile.exists()) throw IllegalStateException("安装包中缺少 proot loader")
      val depDir = File(context.filesDir, "proot-libs").apply { mkdirs() }
      val tallocV2 = File(depDir, "libtalloc.so.2")
      if (!tallocV2.exists()) {
        File(nativeDir, "libtalloc.so").inputStream().use { i ->
          FileOutputStream(tallocV2).use { o -> i.copyTo(o) }
        }
      }
      process = ProcessBuilder(
        prootFile.absolutePath,
        "-r", root.absolutePath,
        "/bin/sh", "-c", "while :; do sleep 3600; done",
      )
        .apply {
          environment()["PROOT_LOADER"] = loaderFile.absolutePath
          environment()["PROOT_TMP_DIR"] = File(context.cacheDir, "proot-tmp").absolutePath.also { File(it).mkdirs() }
          environment()["LD_LIBRARY_PATH"] = "$nativeDir:${depDir.absolutePath}"
          environment()["PROOT_NO_SECCOMP"] = "1"
          environment()["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
        }
        .redirectErrorStream(true).start()
      val startedProcess = process!!
      if (!startedProcess.isAlive) {
        process = null
        throw IllegalStateException("proot 进程启动后立即退出")
      }
      Thread {
        try { startedProcess.inputStream.bufferedReader().useLines { it.forEach { _ -> } } } catch (_: Exception) {}
        startedProcess.waitFor()
        synchronized(this) { if (process === startedProcess) process = null }
      }.apply { name = "karin-proot-output"; isDaemon = true }.start()
      promise.resolve("running")
    } catch (error: Exception) { promise.reject("PROOT_START_FAILED", error) }
  }

  @ReactMethod
  fun stop(promise: Promise) { process?.destroy(); process = null; promise.resolve("stopped") }

  @ReactMethod
  fun status(promise: Promise) { promise.resolve(if (process?.isAlive == true) "running" else "stopped") }

  private fun copyAsset(path: String, target: File) {
    if (target.exists()) return
    target.parentFile?.mkdirs()
    context.assets.open(path).use { input -> FileOutputStream(target).use { output -> input.copyTo(output) } }
  }

  private fun extractRootfs(archive: File, root: File) {
    XZInputStream(archive.inputStream().buffered()).use { xz ->
      TarArchiveInputStream(xz).use { tar ->
        var entry = tar.nextEntry
        val rootPath = root.canonicalFile.toPath()
        while (entry != null) {
          val target = File(root, entry.name).canonicalFile
          if (!target.toPath().startsWith(rootPath)) throw IllegalStateException("镜像包含非法路径")
          when {
            entry.isDirectory -> target.mkdirs()
            entry.isSymbolicLink -> {
              target.parentFile?.mkdirs()
              runCatching { java.nio.file.Files.createSymbolicLink(target.toPath(), java.nio.file.Paths.get(entry.linkName)) }
            }
            entry.isFile -> {
              target.parentFile?.mkdirs()
              FileOutputStream(target).use { tar.copyTo(it) }
              if (entry.mode and 0b001001001 != 0) target.setExecutable(true, false)
            }
          }
          entry = tar.nextEntry
        }
      }
    }
  }
}
