package dev.lenota.desktop

import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  // App navigation is managed in React, rather than WebView URL history.
  override val handleBackNavigation: Boolean = false
  private var noteWebView: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    noteWebView = webView
    // Keep the WebView outside status bars, cutouts, and the keyboard. CSS
    // safe-area insets continue to handle iOS and browser installations.
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
      val keyboardOpen = insets.isVisible(WindowInsetsCompat.Type.ime())
      webView.evaluateJavascript(
        "window.__LENOTA_KEYBOARD_OPEN__ = $keyboardOpen; window.dispatchEvent(new Event('lenota:keyboard'));",
        null
      )
      (view.layoutParams as? ViewGroup.MarginLayoutParams)?.let { params ->
        val bottom = maxOf(bars.bottom, keyboard.bottom)
        if (params.leftMargin != bars.left || params.topMargin != bars.top || params.rightMargin != bars.right || params.bottomMargin != bottom) {
          params.setMargins(bars.left, bars.top, bars.right, bottom)
          view.layoutParams = params
        }
      }
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(webView)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val webView = noteWebView
        if (webView == null) { exit(); return }
        webView.evaluateJavascript("window.__LENOTA_BACK__ ? window.__LENOTA_BACK__() : false") { handled ->
          if (handled != "true") exit()
        }
      }
      private fun exit() {
        isEnabled = false
        onBackPressedDispatcher.onBackPressed()
        isEnabled = true
      }
    })
  }
}
