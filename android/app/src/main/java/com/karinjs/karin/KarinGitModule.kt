package com.karinjs.karin

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.util.UUID
import java.util.concurrent.Executors

/** React Native bridge for host-side libgit2 operations. */
class KarinGitModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  private val service = KarinGitService(reactContext)
  private val executor = Executors.newCachedThreadPool { task -> Thread(task, "karin-git").apply { isDaemon = true } }

  override fun getName() = "KarinGit"
  @ReactMethod fun isAvailable(promise: Promise) = promise.resolve(service.isAvailable())
  @ReactMethod fun isRepository(path: String, promise: Promise) = read(promise, "GIT_REPOSITORY_FAILED") { service.isRepository(path) }
  @ReactMethod fun pathState(path: String, promise: Promise) = read(promise, "GIT_PATH_FAILED") { service.pathState(path) }
  @ReactMethod fun listRepositories(promise: Promise) = read(promise, "GIT_LIST_FAILED") { service.listRepositories() }

  @ReactMethod fun clone(url: String, path: String, branch: String?, depth: Int, operationId: String?, promise: Promise) =
    operation(promise, "GIT_CLONE_FAILED", operationId) { id, progress -> service.clone(url, path, branch, depth, id, progress) }
  @ReactMethod fun update(url: String, path: String, branch: String?, operationId: String?, promise: Promise) =
    operation(promise, "GIT_UPDATE_FAILED", operationId) { id, progress -> service.update(url, path, branch, id, progress) }
  @ReactMethod fun fetch(path: String, unshallow: Boolean, prune: Boolean, operationId: String?, promise: Promise) =
    operation(promise, "GIT_FETCH_FAILED", operationId) { id, progress -> service.fetch(path, unshallow, prune, id, progress) }
  @ReactMethod fun checkout(path: String, commit: String, operationId: String?, promise: Promise) =
    operation(promise, "GIT_CHECKOUT_FAILED", operationId) { id, progress -> service.checkout(path, commit, id, progress) }

  @ReactMethod fun status(path: String, includeUntracked: Boolean, promise: Promise) = read(promise, "GIT_STATUS_FAILED") { service.status(path, includeUntracked) }
  @ReactMethod fun log(path: String, limit: Int, promise: Promise) = read(promise, "GIT_LOG_FAILED") { service.log(path, limit) }
  @ReactMethod fun head(path: String, promise: Promise) = read(promise, "GIT_HEAD_FAILED") { service.head(path) }
  @ReactMethod fun remoteUrl(path: String, promise: Promise) = read(promise, "GIT_REMOTE_FAILED") { service.remoteUrl(path) }
  @ReactMethod fun setRemoteUrl(path: String, url: String, promise: Promise) = read(promise, "GIT_REMOTE_FAILED") { service.setRemoteUrl(path, url) }
  @ReactMethod fun isShallow(path: String, promise: Promise) = read(promise, "GIT_SHALLOW_FAILED") { service.isShallow(path) }

  // Synchronous registration/cancellation means a cancel can never overtake worker startup.
  @ReactMethod fun cancel(operationId: String, promise: Promise) = promise.resolve(service.cancel(operationId))

  private fun read(promise: Promise, code: String, block: () -> Any?) {
    executor.execute { try { promise.resolve(block()) } catch (error: Throwable) { promise.reject(code, error.message, error) } }
  }

  private fun operation(promise: Promise, code: String, requestedId: String?, block: (String, (String) -> Unit) -> String) {
    val id = requestedId?.takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString()
    if (!service.reserveOperation(id)) {
      promise.reject(code, "Git 操作已在运行：$id")
      return
    }
    executor.execute {
      try {
        val progress: (String) -> Unit = { message ->
          val event = Arguments.createMap().apply { putString("operationId", id); putString("message", message) }
          reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("KarinGitProgress", event)
        }
        promise.resolve(block(id, progress))
      } catch (error: Throwable) {
        promise.reject(code, error.message, error)
      } finally {
        service.finishOperation(id)
      }
    }
  }
}
