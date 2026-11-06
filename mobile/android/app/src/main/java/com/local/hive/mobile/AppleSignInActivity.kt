package com.local.hive.mobile

import android.annotation.SuppressLint
import android.os.Bundle
import android.os.Message
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.lifecycleScope
import com.local.hive.mobile.ui.theme.Hive
import com.local.hive.mobile.ui.theme.HiveText
import com.local.hive.mobile.ui.HiveThemed
import com.local.hive.mobile.ui.MainViewModel
import com.local.hive.mobile.ui.PageBar
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Apple Music's own sign-in page, inside Hive: the user signs in to Apple
 * there (Hive never sees the Apple ID or password), and once Apple's page
 * has signed them in, Hive keeps the library key it leaves behind
 * ("media-user-token") and closes. Apple's sign-in opens in a second window,
 * shown over the first until it closes itself.
 */
class AppleSignInActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()
    private lateinit var frame: FrameLayout
    private val popups = mutableListOf<WebView>()
    private var done = false

    @SuppressLint("SetJavaScriptEnabled")
    private fun web(): WebView = WebView(this).apply {
        layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.javaScriptCanOpenWindowsAutomatically = true
        settings.setSupportMultipleWindows(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
        webViewClient = WebViewClient()
        webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
                val popup = web()
                popups += popup
                frame.addView(popup)
                (resultMsg.obj as WebView.WebViewTransport).webView = popup
                resultMsg.sendToTarget()
                return true
            }
            override fun onCloseWindow(window: WebView) {
                popups.remove(window)
                frame.removeView(window)
                window.destroy()
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        CookieManager.getInstance().setAcceptCookie(true)
        frame = FrameLayout(this)
        val main = web()
        frame.addView(main)
        main.loadUrl("https://music.apple.com/${vm.appleUser.value.storefront}/login")
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val top = popups.lastOrNull()
                when {
                    top != null && top.canGoBack() -> top.goBack()
                    top != null -> { popups.remove(top); frame.removeView(top); top.destroy() }
                    main.canGoBack() -> main.goBack()
                    else -> finish()
                }
            }
        })
        setContent {
            HiveThemed(vm) {
                val c = Hive.colors
                Column(Modifier.fillMaxSize().background(c.bg)) {
                    Box(Modifier.statusBarsPadding()) { PageBar("Sign in to Apple Music", 1f, onBack = ::finish) }
                    Text(
                        "This is Apple's own page. Hive never sees your password; it keeps only the key Apple gives your library. Apple doesn't support this for other apps, so it may stop working.",
                        style = HiveText.small, color = c.textDim, modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
                    )
                    AndroidView({ frame }, Modifier.fillMaxWidth().weight(1f).navigationBarsPadding())
                }
            }
        }
        // Apple's page signs in, then leaves the library key in a cookie (and in MusicKit).
        lifecycleScope.launch {
            while (!done) {
                delay(1_000)
                val cookie = CookieManager.getInstance().getCookie("https://music.apple.com").orEmpty()
                val token = Regex("""(?:^|;\s*)media-user-token=([^;]+)""").find(cookie)?.groupValues?.get(1)
                if (!token.isNullOrBlank() && token.length > 20) { finishWith(token); break }
                main.evaluateJavascript("(function(){try{return MusicKit.getInstance().musicUserToken||''}catch(e){return ''}})()") { v ->
                    val t = v?.trim('"').orEmpty()
                    if (t.length > 20 && !done) finishWith(t)
                }
            }
        }
    }

    private fun finishWith(token: String) {
        if (done) return
        done = true
        val app = application as HiveApp
        app.scope.launch { app.appleAccount.complete(token) }
        finish()
    }

    override fun onDestroy() {
        popups.forEach { it.destroy() }
        super.onDestroy()
    }
}
