package com.karinjs.karin

import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import com.facebook.react.bridge.Promise
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import rikka.shizuku.Shizuku

/** root 与 Shizuku 两条路写的是同一组白名单命令，放一起避免两边写岔。 */
internal fun keepAliveWhitelistCommands(pkg: String): List<String> = listOf(
  "dumpsys deviceidle whitelist +$pkg",
  "cmd appops set $pkg RUN_ANY_IN_BACKGROUND allow",
  "cmd appops set $pkg START_FOREGROUND allow",
)

/**
 * Shizuku 保活通道：借 Shizuku（adb/root 身份）执行 PC adb 那几条白名单命令，
 * 让没有 root 但装了 Shizuku 的设备也能一键写 Doze 白名单、放开 appops。
 *
 * 只在保活设置页被调用，跟容器 / proot 生命周期无关。Shizuku 未安装、服务没跑或没授权时
 * 一律返回失败，UI 据此降级到「复制 adb 命令」。
 */
object ShizukuKeepAlive {
  /** Shizuku 管理端包名；Android 11+ 读它需要 manifest 里的 <queries> 声明。 */
  private const val MANAGER_PACKAGE = "moe.shizuku.privileged.api"
  /** 授权回调的 requestCode，只要自己认得出就行。 */
  private const val PERMISSION_REQUEST_CODE = 0x4B41
  /** 用户没理会 Shizuku 的授权弹窗时，别让 Promise 一直悬着。 */
  private const val PERMISSION_TIMEOUT_MS = 60_000L
  /** 单条命令的超时：dumpsys / cmd 都是秒回，5 秒不回来就当卡死。 */
  private const val COMMAND_TIMEOUT_MS = 5_000L

  fun isInstalled(context: Context): Boolean = try {
    context.packageManager.getPackageInfo(MANAGER_PACKAGE, 0)
    true
  } catch (_: Exception) {
    false
  }

  /** Shizuku 服务是否在跑：服务端会把 binder 推给我们，收到即代表在跑。 */
  fun isRunning(): Boolean = try {
    Shizuku.pingBinder()
  } catch (_: Throwable) {
    false
  }

  fun hasPermission(): Boolean {
    if (!isRunning()) return false
    // Shizuku v10 及以下在管理器里一次性授权，没有运行时申请。
    if (Shizuku.isPreV11()) return true
    return try {
      Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
    } catch (_: Throwable) {
      false
    }
  }

  /**
   * 拉起 Shizuku 自己的授权弹窗（Android 11+ 需要 Shizuku 服务在跑），
   * 结果通过监听回调拿到后 resolve；用户一直不理会则超时按未授权处理。
   */
  fun requestPermission(promise: Promise) {
    if (!isRunning()) {
      promise.resolve(false)
      return
    }
    if (hasPermission()) {
      promise.resolve(true)
      return
    }

    val handler = Handler(Looper.getMainLooper())
    var listener: Shizuku.OnRequestPermissionResultListener? = null
    var timeout: Runnable? = null
    var settled = false
    fun settle(granted: Boolean) {
      if (settled) return
      settled = true
      listener?.let { Shizuku.removeRequestPermissionResultListener(it) }
      timeout?.let { handler.removeCallbacks(it) }
      promise.resolve(granted)
    }

    listener = Shizuku.OnRequestPermissionResultListener { requestCode, grantResult ->
      if (requestCode == PERMISSION_REQUEST_CODE) settle(grantResult == PackageManager.PERMISSION_GRANTED)
    }
    timeout = Runnable { settle(hasPermission()) }
    handler.postDelayed(timeout!!, PERMISSION_TIMEOUT_MS)
    Shizuku.addRequestPermissionResultListener(listener!!)
    try {
      Shizuku.requestPermission(PERMISSION_REQUEST_CODE)
    } catch (_: Throwable) {
      settle(false)
    }
  }

  /** 逐条执行白名单命令，返回逐条结果文本（单条失败不影响其余，与 root 路径一致）。 */
  fun applyKeepAlive(context: Context): String {
    val results = keepAliveWhitelistCommands(context.packageName).map { command ->
      val exitCode = runCommand(command)
      "${command.substringBefore(' ')}: ${if (exitCode == 0) "ok" else "failed"}"
    }
    val detail = results.joinToString("\n")
    // 一条都没成功说明 Shizuku 通道断了（服务停了 / 权限被撤 / 反射入口没了），此时 reject；
    // 只有退出码读不出来（不同版本实现差异）才拿系统的 Doze 白名单兜底，别误报成失败。
    val whitelisted = (context.getSystemService(Context.POWER_SERVICE) as PowerManager)
      .isIgnoringBatteryOptimizations(context.packageName)
    if (results.none { it.endsWith("ok") } && !whitelisted) throw IllegalStateException(detail)
    return detail
  }

  /**
   * 用 Shizuku 的 shell（uid=2000，与 PC adb 同权限）跑一条命令，返回退出码，失败返回 null。
   *
   * Shizuku API 13 把 newProcess 收成了私有方法（官方改推 user service），这里反射调用；
   * 拿到的仍是普通 Process，命令语义和 adb 完全一致，跨版本不用自己拼 transaction code。
   */
  private fun runCommand(command: String): Int? {
    val process = try {
      spawn(arrayOf("sh", "-c", command))
    } catch (_: Exception) {
      null
    } ?: return null
    return try {
      // 输出必须读干净，否则远端写满管道会卡住，waitFor 永远不返回。
      val watchdog = ScheduledThreadPoolExecutor(1) { task -> Thread(task).apply { isDaemon = true } }
      watchdog.schedule({ process.destroy() }, COMMAND_TIMEOUT_MS, TimeUnit.MILLISECONDS)
      process.inputStream.bufferedReader().readText()
      val exited = process.waitFor(2, TimeUnit.SECONDS)
      watchdog.shutdownNow()
      if (exited) process.exitValue() else null
    } catch (_: Exception) {
      null
    } finally {
      process.destroy()
    }
  }

  private fun spawn(command: Array<String>): Process? {
    val method = Shizuku::class.java.getDeclaredMethod(
      "newProcess",
      Array<String>::class.java,
      Array<String>::class.java,
      String::class.java,
    )
    method.isAccessible = true
    return method.invoke(null, command, null, null) as? Process
  }
}
