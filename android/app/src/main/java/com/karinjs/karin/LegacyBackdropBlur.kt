@file:Suppress("DEPRECATION")

package com.karinjs.karin

import android.content.Context
import android.graphics.Bitmap
import android.renderscript.Allocation
import android.renderscript.RenderScript
import android.renderscript.ScriptIntrinsicBlur
import android.renderscript.Element

/** Android 7-11 still provide this intrinsic; newer versions use RenderEffect instead. */
internal class LegacyBackdropBlur(context: Context) {
  private val renderScript = RenderScript.create(context.applicationContext)
  private val blur = ScriptIntrinsicBlur.create(renderScript, Element.U8_4(renderScript))
  private var input: Allocation? = null
  private var output: Allocation? = null

  fun apply(bitmap: Bitmap, radius: Float) {
    val source = input ?: Allocation.createFromBitmap(
      renderScript, bitmap, Allocation.MipmapControl.MIPMAP_NONE, Allocation.USAGE_SCRIPT,
    ).also {
      input = it
      output = Allocation.createTyped(renderScript, it.type)
    }
    source.copyFrom(bitmap)
    blur.setRadius(radius)
    blur.setInput(source)
    blur.forEach(output!!)
    output!!.copyTo(bitmap)
  }

  fun releaseBuffers() {
    input?.destroy()
    output?.destroy()
    input = null
    output = null
  }

  fun destroy() {
    releaseBuffers()
    blur.destroy()
    renderScript.destroy()
  }
}
