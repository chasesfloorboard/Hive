# kotlinx.serialization: keep generated serializers for the Hive Link models.
-keepclassmembers class com.local.hive.mobile.** { *** Companion; }
-keepclasseswithmembers class com.local.hive.mobile.** { kotlinx.serialization.KSerializer serializer(...); }

# jaudiotagger builds ID3 frame bodies by class name, so it is kept whole; its
# desktop-only image code (AWT, ImageIO) is never reached on Android.
-keep class org.jaudiotagger.** { *; }
-dontwarn java.awt.**
-dontwarn javax.imageio.**
-dontwarn javax.swing.**
-dontwarn java.beans.**

# Keep sandboxed plugin WebView JS bridge methods in minified release builds.
-keepattributes *Annotation*
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
