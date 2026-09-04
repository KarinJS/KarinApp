package com.karinjs.karin

import android.content.Context
import android.system.Os
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.Paths
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.tukaani.xz.XZInputStream

/** 设置文件权限；Os.chmod 不可用时退回 Java File API。 */
internal fun chmod(file: File, mode: Int) {
  try { Os.chmod(file.absolutePath, mode and 0x1ff) } catch (_: Exception) {
    file.setReadable(mode and 0x124 != 0, false); file.setWritable(mode and 0x92 != 0, false); file.setExecutable(mode and 0x49 != 0, false)
  }
}

/**
 * 负责把 assets 里的 debian rootfs（tar.xz）解包到应用私有目录。
 * 解包成功后写入 .karin-ready 标记，之后直接复用；解包失败会清理目录以便下次重试。
 */
internal class RootfsInstaller(private val context: Context) {

  /** 返回可用的容器根目录；首次调用或目录不完整时执行解包。 */
  fun ensureContainer(): File {
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
              current.isSymbolicLink -> { target.parentFile?.mkdirs(); Files.createSymbolicLink(target.toPath(), Paths.get(current.linkName)) }
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
        Files.createLink(link.toPath(), source.toPath())
      } catch (error: Exception) {
        // 部分 Android 文件系统/内核不允许创建硬链接，退化为复制文件内容
        if (!source.isFile) throw error
        source.copyTo(link, overwrite = true)
        chmod(link, mode)
      }
    }
  }

  /** 防止镜像条目通过绝对路径或 .. 逃逸出容器根目录。 */
  private fun safeTarget(rootPath: java.nio.file.Path, name: String): File {
    val relative = Paths.get(name).normalize()
    if (relative.isAbsolute || relative.startsWith("..")) throw IllegalStateException("镜像包含非法路径: $name")
    val target = rootPath.resolve(relative).normalize()
    if (!target.startsWith(rootPath)) throw IllegalStateException("镜像包含非法路径: $name")
    return target.toFile()
  }

  private companion object {
    val extractLock = Any()
  }
}
