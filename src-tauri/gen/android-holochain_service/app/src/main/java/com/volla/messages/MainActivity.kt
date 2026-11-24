package com.volla.messages

import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    // From targetSdk 35 Android draws apps under the status bar, the
    // navigation bar and the keyboard (edge-to-edge), and 36 removes the
    // opt-out; the web view does not account for them. Pad the content by
    // those areas instead, on every Android version, so the page keeps the
    // layout it had before and nothing hides behind the system bars.
    WindowCompat.setDecorFitsSystemWindows(window, false)

    val night =
      (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
        Configuration.UI_MODE_NIGHT_YES
    val content = findViewById<View>(android.R.id.content)
    // Shows behind the now transparent system bars; matches the app's page.
    content.setBackgroundColor(if (night) Color.BLACK else Color.WHITE)

    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val covered =
        insets.getInsets(
          WindowInsetsCompat.Type.systemBars() or
            WindowInsetsCompat.Type.displayCutout() or
            WindowInsetsCompat.Type.ime(),
        )
      view.setPadding(covered.left, covered.top, covered.right, covered.bottom)
      WindowInsetsCompat.CONSUMED
    }

    // Dark icons on the light page, light icons on the dark one.
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = !night
      isAppearanceLightNavigationBars = !night
    }
  }
}
