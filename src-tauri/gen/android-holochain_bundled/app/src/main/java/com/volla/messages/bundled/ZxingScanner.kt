package com.volla.messages.bundled

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.Drawable
import android.net.Uri
import android.provider.Settings
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout
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
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.camera.CameraSettings
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.journeyapps.barcodescanner.DefaultDecoderFactory

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
    private lateinit var webView: WebView
    private var barcodeView: DecoratedBarcodeView? = null
    private var savedInvoke: Invoke? = null
    private var webViewBackground: Drawable? = null
    private var windowed = false

    override fun load(webView: WebView) {
        super.load(webView)
        this.webView = webView
    }

    private fun hasCamera(): Boolean {
        return activity.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
    }

    private fun resolveFormats(formats: Array<String>?): List<BarcodeFormat> {
        if (formats.isNullOrEmpty()) {
            return listOf(BarcodeFormat.QR_CODE)
        }

        return formats.mapNotNull {
            try {
                BarcodeFormat.valueOf(it)
            } catch (_: IllegalArgumentException) {
                null
            }
        }.ifEmpty { listOf(BarcodeFormat.QR_CODE) }
    }

    private fun setupScanner(options: ScanOptions) {
        activity.runOnUiThread {
            destroyScannerViewInternal()

            val scannerView = DecoratedBarcodeView(activity)
            scannerView.layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )

            val parent = webView.parent as ViewGroup
            parent.addView(scannerView, 0)
            barcodeView = scannerView

            this.windowed = options.windowed
            if (options.windowed) {
                webView.bringToFront()
                webViewBackground = webView.background
                webView.setBackgroundColor(Color.TRANSPARENT)
            }

            val cameraSettings: CameraSettings = scannerView.barcodeView.cameraSettings
            cameraSettings.requestedCameraId = if (options.cameraDirection == "front") 1 else 0
            scannerView.barcodeView.cameraSettings = cameraSettings
            scannerView.barcodeView.decoderFactory = DefaultDecoderFactory(resolveFormats(options.formats))

            scannerView.decodeContinuous(object : BarcodeCallback {
                override fun barcodeResult(result: BarcodeResult?) {
                    val text = result?.text ?: return
                    val invoke = savedInvoke ?: return

                    val payload = JSObject()
                    payload.put("content", text)
                    payload.put("format", result.barcodeFormat.name)
                    payload.put("bounds", null)

                    savedInvoke = null
                    destroyScannerView()
                    invoke.resolve(payload)
                }

                override fun possibleResultPoints(resultPoints: MutableList<com.google.zxing.ResultPoint>?) {
                    // Optional visual feedback hook
                }
            })

            scannerView.resume()
        }
    }

    private fun destroyScannerViewInternal() {
        barcodeView?.pause()
        val parent = webView.parent as? ViewGroup
        if (parent != null && barcodeView != null) {
            parent.removeView(barcodeView)
        }
        barcodeView = null

        if (windowed) {
            if (webViewBackground != null) {
                webView.background = webViewBackground
                webViewBackground = null
            } else {
                webView.setBackgroundColor(Color.WHITE)
            }
        }

        windowed = false
    }

    private fun destroyScannerView() {
        activity.runOnUiThread {
            destroyScannerViewInternal()
        }
    }

    @Command
    fun scan(invoke: Invoke) {
        if (!hasCamera()) {
            invoke.reject("No camera available on this device")
            return
        }

        if (getPermissionState("camera") != PermissionState.GRANTED) {
            invoke.reject("No permission to use camera. Did you request it yet?")
            return
        }

        val options = invoke.parseArgs(ScanOptions::class.java)
        savedInvoke = invoke
        setupScanner(options)
    }

    @Command
    fun cancel(invoke: Invoke) {
        val scanInvoke = savedInvoke
        savedInvoke = null
        destroyScannerView()
        scanInvoke?.reject("cancelled")
        invoke.resolve()
    }

    @Command
    fun openAppSettings(invoke: Invoke) {
        val intent = Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", activity.packageName, null)
        )
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivityForResult(invoke, intent, "openSettingsResult")
    }

    @ActivityCallback
    private fun openSettingsResult(invoke: Invoke, _result: ActivityResult) {
        invoke.resolve()
    }
}
