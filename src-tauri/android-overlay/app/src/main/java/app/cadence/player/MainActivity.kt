package app.cadence.player

import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
    override val handleBackNavigation: Boolean = false

    private var activeWebView: WebView? = null
    private var backCallbackRegistered: Boolean = false

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        // Ensure dark launch appearance until WebView notifies light/dark theme change.
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
    }

    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        activeWebView = webView
        webView.setBackgroundColor(Color.parseColor("#08080b"))
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.overScrollMode = View.OVER_SCROLL_NEVER

        if (!backCallbackRegistered) {
            backCallbackRegistered = true
            onBackPressedDispatcher.addCallback(
                this,
                object : OnBackPressedCallback(true) {
                    override fun handleOnBackPressed() {
                        val wv = activeWebView
                        if (wv == null) {
                            finish()
                            return
                        }
                        wv.evaluateJavascript(
                            "window.__cadenceHandleAndroidBack ? window.__cadenceHandleAndroidBack() : 'exit'"
                        ) { raw ->
                            val action = raw?.trim()?.removeSurrounding("\"")
                            when (action) {
                                "handled" -> Unit
                                "minimize" -> moveTaskToBack(true)
                                else -> finish()
                            }
                        }
                    }
                }
            )
        }
    }
}
