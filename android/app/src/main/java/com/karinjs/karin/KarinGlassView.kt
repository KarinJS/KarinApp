package com.karinjs.karin

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.RenderEffect
import android.graphics.Shader
import android.os.Build
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import com.facebook.react.uimanager.util.ReactFindViewUtil
import kotlin.math.ceil
import kotlin.math.max

/** A bounded backdrop snapshot; the tint and rounded clipping belong to its React parent. */
class KarinGlassView(context: Context) : View(context) {
  private var sourceNativeID: String? = null
  private var source: View? = null
  private var snapshot: Bitmap? = null
  private var captureBitmap: Bitmap? = null
  private var snapshotCanvas: Canvas? = null
  private var legacyBlur: LegacyBackdropBlur? = null
  private var blurRadiusPx = 20f * resources.displayMetrics.density
  private var observer: ViewTreeObserver? = null
  private var needsCapture = true
  private var captureFailed = false
  private val sourceLocation = IntArray(2)
  private val ownLocation = IntArray(2)
  private val destination = RectF()
  private val bitmapPaint = Paint(Paint.FILTER_BITMAP_FLAG)

  private val layoutListener = ViewTreeObserver.OnGlobalLayoutListener { needsCapture = true }
  private val scrollListener = ViewTreeObserver.OnScrollChangedListener { needsCapture = true }
  private val preDrawListener = ViewTreeObserver.OnPreDrawListener {
    captureBackdrop()
    true
  }

  init {
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    isFocusable = false
    isClickable = false
    setBlurRadius(20f)
  }

  fun setSourceNativeID(value: String?) {
    if (sourceNativeID == value) return
    sourceNativeID = value
    source = null
    captureFailed = false
    needsCapture = true
    releaseSnapshot()
    invalidate()
  }

  fun setBlurRadius(radiusDp: Float) {
    blurRadiusPx = radiusDp.coerceIn(0f, 40f) * resources.displayMetrics.density
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      setRenderEffect(
        if (blurRadiusPx > 0f) {
          RenderEffect.createBlurEffect(blurRadiusPx, blurRadiusPx, Shader.TileMode.CLAMP)
        }
        else null,
      )
    }
    needsCapture = true
    invalidate()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    needsCapture = true
    captureFailed = false
    observer = viewTreeObserver.also {
      it.addOnPreDrawListener(preDrawListener)
      it.addOnGlobalLayoutListener(layoutListener)
      it.addOnScrollChangedListener(scrollListener)
    }
  }

  override fun onDetachedFromWindow() {
    observer?.takeIf { it.isAlive }?.let {
      it.removeOnPreDrawListener(preDrawListener)
      it.removeOnGlobalLayoutListener(layoutListener)
      it.removeOnScrollChangedListener(scrollListener)
    }
    observer = null
    source = null
    releaseSnapshot()
    legacyBlur?.destroy()
    legacyBlur = null
    super.onDetachedFromWindow()
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    destination.set(0f, 0f, w.toFloat(), h.toFloat())
    needsCapture = true
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    snapshot?.let { canvas.drawBitmap(it, null, destination, bitmapPaint) }
  }

  private fun captureBackdrop() {
    if (captureFailed || !isShown || width <= 0 || height <= 0) return
    val nativeID = sourceNativeID ?: return
    val target = source?.takeIf { it.isAttachedToWindow }
      ?: ReactFindViewUtil.findView(rootView, nativeID)?.also {
        // Sampling an ancestor would include this glass view and recursively feed it back.
        if (isSelfOrAncestor(it)) return
        source = it
        needsCapture = true
      }
      ?: return
    if (!target.isShown || target.width <= 0 || target.height <= 0) return
    if (!needsCapture && !hasDirtyContent(target)) return
    needsCapture = false

    // Cap the allocation even if a future caller accidentally sizes the view to the full screen.
    val scale = max(max(4f, blurRadiusPx / 25f), max(width / 320f, height / 160f))
    val bitmapWidth = ceil(width / scale).toInt()
    val bitmapHeight = ceil(height / scale).toInt()
    if (snapshot != null && (snapshot?.width != bitmapWidth || snapshot?.height != bitmapHeight)) {
      releaseSnapshot()
    }
    val buffer = captureBitmap ?: Bitmap.createBitmap(
      bitmapWidth, bitmapHeight, Bitmap.Config.ARGB_8888,
    ).also { captureBitmap = it }
    val canvas = snapshotCanvas ?: Canvas().also { snapshotCanvas = it }
    canvas.setBitmap(buffer)
    target.getLocationInWindow(sourceLocation)
    getLocationInWindow(ownLocation)
    buffer.eraseColor(Color.TRANSPARENT)
    val saved = canvas.save()
    try {
      canvas.scale(bitmapWidth.toFloat() / width, bitmapHeight.toFloat() / height)
      canvas.translate(
        (sourceLocation[0] - ownLocation[0]).toFloat(),
        (sourceLocation[1] - ownLocation[1]).toFloat(),
      )
      canvas.clipRect(0, 0, target.width, target.height)
      target.draw(canvas)
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S && blurRadiusPx > 0f) {
        val blur = legacyBlur ?: LegacyBackdropBlur(context).also { legacyBlur = it }
        blur.apply(buffer, (blurRadiusPx / scale).coerceIn(0.1f, 25f))
      }
    } catch (error: RuntimeException) {
      // Surface/hardware-only content cannot always be drawn to a software canvas.
      Log.w("KarinGlassView", "Backdrop capture unavailable; keeping the glass tint", error)
      captureFailed = true
    } finally {
      canvas.restoreToCount(saved)
    }
    if (captureFailed) {
      releaseSnapshot()
    } else {
      // Clipped children can remain dirty after drawing. Identical pixels must not schedule frames.
      if (snapshot?.sameAs(buffer) == true) return
      captureBitmap = snapshot
      snapshot = buffer
    }
    // Only a content/layout/scroll change requests another draw, never the glass draw itself.
    invalidate()
  }

  private fun isSelfOrAncestor(candidate: View): Boolean {
    var view: View? = this
    while (view != null) {
      if (view === candidate) return true
      view = view.parent as? View
    }
    return false
  }

  private fun hasDirtyContent(view: View): Boolean {
    if (view.isDirty) return true
    if (view is ViewGroup) {
      for (index in 0 until view.childCount) {
        if (hasDirtyContent(view.getChildAt(index))) return true
      }
    }
    return false
  }

  private fun releaseSnapshot() {
    legacyBlur?.releaseBuffers()
    snapshotCanvas?.setBitmap(null)
    snapshotCanvas = null
    snapshot?.recycle()
    snapshot = null
    captureBitmap?.recycle()
    captureBitmap = null
  }
}
