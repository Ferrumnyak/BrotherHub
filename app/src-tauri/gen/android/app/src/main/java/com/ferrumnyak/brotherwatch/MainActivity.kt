package com.ferrumnyak.brotherwatch

import android.content.res.Configuration
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // Ушли на рабочий стол, пока идёт видео, — уходим в «картинку в картинке»
  // (Android 12+ делает это сам, см. PlayerPlugin.updatePip).
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    PlayerPlugin.instance?.onUserLeave()
  }

  override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    PlayerPlugin.instance?.onPip(isInPictureInPictureMode)
  }
}
