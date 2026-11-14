# Keep Cadence Tauri Android plugin, Media3 service, and JNI reflection hooks intact under R8
-keep class app.cadence.player.** { *; }
-keepclassmembers class app.cadence.player.** { *; }
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod
-keep @app.tauri.annotation.TauriPlugin class * { *; }
-keep @app.tauri.annotation.InvokeArg class * { *; }
-keepclassmembers class * {
    @app.tauri.annotation.Command <methods>;
    @app.tauri.annotation.PermissionCallback <methods>;
    @app.tauri.annotation.ActivityCallback <methods>;
}
-keepclassmembers class app.tauri.plugin.Plugin { *; }
-dontwarn androidx.media3.**
