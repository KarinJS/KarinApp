# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# Shizuku API 13 把 newProcess 收成了私有方法，只能靠反射调用，混淆/裁剪都不能动它。
-keepclassmembers class rikka.shizuku.Shizuku {
    private static *** newProcess(...);
}
