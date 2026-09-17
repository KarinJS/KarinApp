package com.karinjs.karin

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManager
import com.facebook.react.uimanager.annotations.ReactProp

class KarinGlassViewManager : SimpleViewManager<KarinGlassView>() {
  override fun getName(): String = "KarinGlassView"

  override fun createViewInstance(context: ThemedReactContext): KarinGlassView = KarinGlassView(context)

  @ReactProp(name = "sourceNativeID")
  fun setSourceNativeID(view: KarinGlassView, value: String?) = view.setSourceNativeID(value)

  @ReactProp(name = "blurRadius", defaultFloat = 20f)
  fun setBlurRadius(view: KarinGlassView, value: Float) = view.setBlurRadius(value)
}

class KarinGlassPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = emptyList()

  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> =
    listOf(KarinGlassViewManager())
}
