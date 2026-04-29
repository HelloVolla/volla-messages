package com.volla.messages

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.Drawable
import android.net.Uri
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.appcompat.widget.AppCompatButton
import androidx.activity.result.ActivityResult
import app.tauri.PermissionState
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.zxing.BarcodeFormat
import com.google.zxing.ResultPoint
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.journeyapps.barcodescanner.DefaultDecoderFactory
import com.journeyapps.barcodescanner.camera.CameraSettings

@InvokeArg
class ScanOptions {
    var formats: Array<String>? = null
    var windowed: Boolean = false
    var cameraDirection: String? = null
}

@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.CAMERA], alias = "camera")
    ]
)
class ZxingScannerPlugin(private val activity: Activity) : Plugin(activity) {
    companion object {
        private const val TAG = "ZxingScanner"
    }

    private lateinit var webView: WebView
    private var barcodeView: DecoratedBarcodeView? = null
    private var savedInvoke: Invoke? = null
    private var webViewBackground: Drawable? = null
    private var webViewPreviousVisibility: Int = View.VISIBLE
    private var windowed = false

    private fun dp(value: Int): Int {
        return (value * activity.resources.displayMetrics.density).toInt()
    }

    override fun load(webView: WebView) {
        super.load(webView)
        this.webView = webView
        Log.d(TAG, "load: plugin loaded, webView=$webView")
    }

    private fun hasCamera(): Boolean {
        val hasCamera = activity.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
        Log.d(TAG, "hasCamera: $hasCamera")
        return hasCamera
    }

    private fun resolveFormats(formats: Array<String>?): List<BarcodeFormat> {
        Log.d(TAG, "resolveFormats: requested=${formats?.joinToString()}")
        val resolved =
            if (formats.isNullOrEmpty()) {
                listOf(BarcodeFormat.QR_CODE)
            } else {
                formats.mapNotNull {
                    try {
                        BarcodeFormat.valueOf(it)
                    } catch (_: IllegalArgumentException) {
                        Log.w(TAG, "resolveFormats: unsupported format=$it")
                        null
                    }
                }.ifEmpty { listOf(BarcodeFormat.QR_CODE) }
            }

        Log.d(TAG, "resolveFormats: resolved=${resolved.joinToString()}")
        return resolved
    }

    private fun setupScanner(options: ScanOptions) {
        Log.d(
            TAG,
            "setupScanner: windowed=${options.windowed}, cameraDirection=${options.cameraDirection}, formats=${options.formats?.joinToString()}"
        )

        activity.runOnUiThread {
            try {
                destroyScannerViewInternal()

                val scannerView = DecoratedBarcodeView(activity)
                scannerView.layoutParams = FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )

                val parent = webView.parent as ViewGroup
                Log.d(TAG, "setupScanner: parent=$parent, webViewParentClass=${parent::class.java.name}")

                parent.addView(scannerView, 0)
                barcodeView = scannerView
                Log.d(TAG, "setupScanner: scanner view added to parent")

                this.windowed = options.windowed
                if (options.windowed) {
                    Log.d(TAG, "setupScanner: enabling windowed transparent overlay mode")
                    webView.bringToFront()
                    webViewBackground = webView.background
                    webView.setBackgroundColor(Color.TRANSPARENT)
                    webView.visibility = View.VISIBLE
                } else {
                    // Fullscreen mode: place scanner above webview and hide webview.
                    webViewPreviousVisibility = webView.visibility
                    webView.visibility = View.INVISIBLE
                    scannerView.bringToFront()

                    val cancelButton = AppCompatButton(activity).apply {
                        text = "Cancel"
                        setOnClickListener {
                            Log.d(TAG, "native cancel button clicked")
                            cancelActiveScan()
                        }
                    }
                    val cancelParams = FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT
                    ).apply {
                        gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
                        bottomMargin = dp(48)
                    }
                    scannerView.addView(cancelButton, cancelParams)
                }

                val cameraSettings: CameraSettings = scannerView.barcodeView.cameraSettings
                cameraSettings.requestedCameraId = if (options.cameraDirection == "front") 1 else 0
                scannerView.barcodeView.cameraSettings = cameraSettings
                Log.d(TAG, "setupScanner: requestedCameraId=${cameraSettings.requestedCameraId}")

                val formats = resolveFormats(options.formats)
                scannerView.barcodeView.decoderFactory = DefaultDecoderFactory(formats)
                Log.d(TAG, "setupScanner: decoderFactory configured")

                scannerView.decodeContinuous(object : BarcodeCallback {
                    override fun barcodeResult(result: BarcodeResult?) {
                        if (result == null) {
                            Log.d(TAG, "barcodeResult: result is null")
                            return
                        }

                        val text = result.text
                        if (text.isNullOrEmpty()) {
                            Log.d(TAG, "barcodeResult: empty text")
                            return
                        }

                        Log.d(
                            TAG,
                            "barcodeResult: decoded format=${result.barcodeFormat?.name}, text=$text"
                        )

                        val invoke = savedInvoke
                        if (invoke == null) {
                            Log.w(TAG, "barcodeResult: savedInvoke is null, dropping result")
                            return
                        }

                        val payload = JSObject()
                        payload.put("content", text)
                        payload.put("format", result.barcodeFormat.name)
                        payload.put("bounds", null)

                        savedInvoke = null
                        destroyScannerView()
                        Log.d(TAG, "barcodeResult: resolving invoke with payload")
                        invoke.resolve(payload)
                    }

                    override fun possibleResultPoints(resultPoints: MutableList<ResultPoint>?) {
                        val count = resultPoints?.size ?: 0
                        if (count > 0) {
                            Log.d(TAG, "possibleResultPoints: count=$count")
                        }
                    }
                })

                scannerView.resume()
                Log.d(TAG, "setupScanner: scanner resumed")
            } catch (e: Exception) {
                Log.e(TAG, "setupScanner: failed", e)
                val invoke = savedInvoke
                savedInvoke = null
                destroyScannerViewInternal()
                invoke?.reject("Scanner setup failed: ${e.message}")
            }
        }
    }

    private fun destroyScannerViewInternal() {
        Log.d(TAG, "destroyScannerViewInternal: start")
        barcodeView?.pause()
        val parent = webView.parent as? ViewGroup
        if (parent != null && barcodeView != null) {
            parent.removeView(barcodeView)
            Log.d(TAG, "destroyScannerViewInternal: scanner view removed")
        }
        barcodeView = null

        if (windowed) {
            Log.d(TAG, "destroyScannerViewInternal: restoring webview background")
            if (webViewBackground != null) {
                webView.background = webViewBackground
                webViewBackground = null
            } else {
                webView.setBackgroundColor(Color.WHITE)
            }
        } else {
            webView.visibility = webViewPreviousVisibility
        }

        windowed = false
        Log.d(TAG, "destroyScannerViewInternal: done")
    }

    private fun destroyScannerView() {
        Log.d(TAG, "destroyScannerView: posting to UI thread")
        activity.runOnUiThread {
            destroyScannerViewInternal()
        }
    }

    private fun cancelActiveScan() {
        val scanInvoke = savedInvoke
        savedInvoke = null
        destroyScannerView()
        // Resolve (instead of reject) so JS scan flow can navigate back cleanly
        // without showing stale scan overlay in the webview.
        if (scanInvoke != null) {
            val payload = JSObject()
            payload.put("content", null)
            payload.put("format", null)
            payload.put("bounds", null)
            scanInvoke.resolve(payload)
        }
        Log.d(TAG, "cancelActiveScan: scan invoke resolved as cancelled")
    }

    @Command
    fun scan(invoke: Invoke) {
        Log.d(TAG, "scan: called")
        if (!hasCamera()) {
            Log.e(TAG, "scan: no camera available")
            invoke.reject("No camera available on this device")
            return
        }

        val permissionState = getPermissionState("camera")
        Log.d(TAG, "scan: permissionState=$permissionState")
        if (permissionState != PermissionState.GRANTED) {
            Log.e(TAG, "scan: camera permission not granted")
            invoke.reject("No permission to use camera. Did you request it yet?")
            return
        }

        val options = invoke.parseArgs(ScanOptions::class.java)
        Log.d(
            TAG,
            "scan: parsed options windowed=${options.windowed}, cameraDirection=${options.cameraDirection}, formats=${options.formats?.joinToString()}"
        )

        savedInvoke = invoke
        setupScanner(options)
    }

    @Command
    fun cancel(invoke: Invoke) {
        Log.d(TAG, "cancel: called")
        cancelActiveScan()
        invoke.resolve()
    }

    @Command
    fun openAppSettings(invoke: Invoke) {
        Log.d(TAG, "openAppSettings: opening settings for package=${activity.packageName}")
        val intent = Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", activity.packageName, null)
        )
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivityForResult(invoke, intent, "openSettingsResult")
    }

    @ActivityCallback
    private fun openSettingsResult(invoke: Invoke, _result: ActivityResult) {
        Log.d(TAG, "openSettingsResult: returned from settings")
        invoke.resolve()
    }
}
