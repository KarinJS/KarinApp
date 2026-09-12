package com.karinjs.karin

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * 下载更新包期间的前台服务：切到后台时进程不会被冻进 cached 组，屏幕熄灭后 CPU 与 Wi-Fi 也不休眠
 * （前台服务 + PARTIAL_WAKE_LOCK + 高性能 WifiLock）。少了这层保护，后台化会立刻掐断下载连接
 * （表现为 Software caused connection abort）。锁跟着服务创建/销毁成对持有，不依赖 JS 生命周期。
 */
class UpdateForegroundService : Service() {

  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null

  override fun onCreate() {
    super.onCreate()
    running = true
    createChannel()
    acquireLocks()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    startInForeground(intent?.getIntExtra(EXTRA_PERCENT, PERCENT_UNKNOWN) ?: PERCENT_UNKNOWN)
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    running = false
    releaseLocks()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    super.onDestroy()
  }

  private fun startInForeground(percent: Int) {
    val notification = buildNotification(this, percent)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun acquireLocks() {
    try {
      val power = getSystemService(Context.POWER_SERVICE) as PowerManager
      wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:update").apply {
        setReferenceCounted(false)
        acquire()
      }
    } catch (_: Exception) {
      // 拿不到锁只影响极端省电场景，下载本身照常继续
    }
    try {
      val wifi = getSystemService(Context.WIFI_SERVICE) as WifiManager
      @Suppress("DEPRECATION")
      val highPerf = WifiManager.WIFI_MODE_FULL_HIGH_PERF
      wifiLock = wifi.createWifiLock(highPerf, "$packageName:update").apply {
        setReferenceCounted(false)
        acquire()
      }
    } catch (_: Exception) {
      // 同上：没有 Wi-Fi 锁也能下载，只是息屏后更容易被网络策略打断
    }
  }

  private fun releaseLocks() {
    try {
      if (wakeLock?.isHeld == true) wakeLock?.release()
    } catch (_: Exception) {
      // 释放失败交给系统，进程退出时也会自动回收
    }
    try {
      if (wifiLock?.isHeld == true) wifiLock?.release()
    } catch (_: Exception) {
      // 同上
    }
    wakeLock = null
    wifiLock = null
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(
      CHANNEL_ID,
      getString(R.string.update_foreground_channel_name),
      NotificationManager.IMPORTANCE_LOW,
    ).apply { description = getString(R.string.update_foreground_channel_description) }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  companion object {
    private const val CHANNEL_ID = "karin-update"
    private const val NOTIFICATION_ID = 1002
    private const val EXTRA_PERCENT = "percent"
    private const val PERCENT_UNKNOWN = -1
    /** 服务是否还活着：只有活着时才发进度通知，免得在没有前台服务时留下一条撤不掉的通知 */
    @Volatile private var running = false

    /**
     * 下载流程开始时拉起前台服务；必须在 App 还在前台（用户刚点下载）时调用，
     * 后台起前台服务会被系统拒绝，这里吞掉异常，最坏情况只是没有保活。
     */
    fun start(context: Context) {
      try {
        val intent = Intent(context, UpdateForegroundService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
        else context.startService(intent)
      } catch (_: Exception) {
        // 起不来就退化成没有保活的下载
      }
    }

    /** 刷新通知里的进度：用同一个通知 id 重发，不改动前台服务状态，可从下载线程调用。 */
    fun progress(context: Context, percent: Int) {
      if (!running) return
      try {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.notify(NOTIFICATION_ID, buildNotification(context, percent.coerceIn(0, 100)))
      } catch (_: Exception) {
        // 通知发不出去（例如没给通知权限）不影响下载
      }
    }

    /** 下载结束（不管成功还是失败）都要调：停服务 → onDestroy 释放锁并撤掉通知。 */
    fun stop(context: Context) {
      try {
        context.stopService(Intent(context, UpdateForegroundService::class.java))
      } catch (_: Exception) {
        // 服务已经不在就直接跳过
      }
    }

    private fun buildNotification(context: Context, percent: Int): Notification {
      val intent = Intent(context, MainActivity::class.java).apply { addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP) }
      val pendingIntent = PendingIntent.getActivity(
        context,
        0,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      val known = percent in 0..100
      val text = if (known) {
        context.getString(R.string.update_foreground_text_progress, percent)
      } else {
        context.getString(R.string.update_foreground_text)
      }
      val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(context, CHANNEL_ID)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(context)
      }
      return builder
        .setSmallIcon(R.drawable.ic_karin_notification)
        .setContentTitle(context.getString(R.string.update_foreground_title))
        .setContentText(text)
        .setContentIntent(pendingIntent)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setProgress(100, percent.coerceIn(0, 100), !known)
        .setCategory(Notification.CATEGORY_PROGRESS)
        .build()
    }
  }
}
