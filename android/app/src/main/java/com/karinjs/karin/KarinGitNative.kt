package com.karinjs.karin

/**
 * Thin JNI declaration for the optional libgit2 bridge.
 *
 * The native library is deliberately loaded lazily.  Development builds that
 * do not ship libgit2 can still start the application; callers can check
 * [isAvailable] and report a useful error instead of crashing class loading.
 * The implementation is expected to link libgit2 and expose these JNI symbols
 * for arm64-v8a (see docs/native-git.md).
 */
internal object KarinGitNative {
  private var loadError: Throwable? = null

  init {
    try {
      System.loadLibrary("karin_git")
    } catch (error: Throwable) {
      loadError = error
    }
  }

  fun isAvailable(): Boolean = loadError == null

  fun requireAvailable() {
    loadError?.let { throw IllegalStateException("libgit2 原生模块不可用，请把 libkarin_git.so 放入 arm64-v8a", it) }
  }

  /** Progress/cancellation callback owned by Kotlin for one operation. */
  interface Callback {
    fun onProgress(message: String)
    fun isCancelled(): Boolean
  }

  /** Configure CA bundle path; passing null lets libgit2 use its platform defaults. */
  external fun configure(caFile: String?)

  /** All operations return a UTF-8 JSON object or array. */
  external fun execute(
    action: String,
    repository: String,
    optionsJson: String,
    operationId: String?,
    callback: Callback?,
  ): String

  /** Best-effort interrupt for compatibility with older native builds. */
  external fun cancel(operationId: String): Boolean
}
