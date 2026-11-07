package com.ferrumnyak.brotherwatch

// Пока ты в зале, приложение работает и в свёрнутом виде: фильм и голос не
// обрываются. Android разрешает это только «службе на переднем плане» с
// постоянным уведомлением — это она.

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

class PlaybackService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val room = intent?.getStringExtra(EXTRA_ROOM) ?: "BrotherHub"
        val mic = intent?.getBooleanExtra(EXTRA_MIC, false) ?: false
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "Ты в зале", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val open = PendingIntent.getActivity(
            this,
            0,
            packageManager.getLaunchIntentForPackage(packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL)
        else @Suppress("DEPRECATION") Notification.Builder(this)
        val notification = builder
            .setContentTitle("BrotherHub")
            .setContentText("Ты в зале «$room»")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                // Микрофон в фоне — только если разрешение уже дано.
                if (mic && Build.VERSION.SDK_INT >= 30 &&
                    checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) ==
                    PackageManager.PERMISSION_GRANTED
                ) {
                    types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                }
                startForeground(NOTIFICATION_ID, notification, types)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: Throwable) {
            Log.w("BrotherHub", "служба для фона не запустилась", e)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    companion object {
        const val EXTRA_ROOM = "room"
        const val EXTRA_MIC = "mic"
        private const val CHANNEL = "in-room"
        private const val NOTIFICATION_ID = 1
    }
}
