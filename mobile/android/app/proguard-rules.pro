# kotlinx.serialization: keep generated serializers for the Hive Link models.
-keepclassmembers class com.local.hive.mobile.** { *** Companion; }
-keepclasseswithmembers class com.local.hive.mobile.** { kotlinx.serialization.KSerializer serializer(...); }
