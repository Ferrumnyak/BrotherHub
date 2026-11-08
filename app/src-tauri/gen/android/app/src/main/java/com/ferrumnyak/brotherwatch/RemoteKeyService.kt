package com.ferrumnyak.brotherwatch

// Кнопка «Премьер» на пульте Xiaomi TV — «нажми и говори» в BrotherHub.
//
// Кнопки приложений на таких пультах «глобальные»: их забирает система
// (сервис Xiaomi GlobalKey открывает приложение) и обычному приложению они не
// приходят. Служба специальных возможностей с фильтром клавиш видит нажатия
// раньше — так работают и приложения-переназначатели кнопок. Перехватываем
// только эту кнопку и только пока BrotherHub на экране; в остальное время она
// работает как обычно. Включается в настройках: Специальные возможности →
// BrotherHub (или через adb, см. docs/ANDROID.md).

import android.accessibilityservice.AccessibilityService
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent

class RemoteKeyService : AccessibilityService() {
    override fun onKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode !in TALK_KEYS) return false
        val plugin = PlayerPlugin.instance ?: return false
        if (!plugin.isOnScreen) return false
        if (event.repeatCount == 0 &&
            (event.action == KeyEvent.ACTION_DOWN || event.action == KeyEvent.ACTION_UP)
        ) {
            plugin.pushToTalk(event.action == KeyEvent.ACTION_DOWN, event.keyCode)
        }
        return true
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

    override fun onInterrupt() {}

    override fun onServiceConnected() {
        Log.i("BrotherHub", "пульт: служба кнопок включена")
    }

    companion object {
        /// 354 — «Премьер» на пульте Xiaomi TV.
        val TALK_KEYS = setOf(354)
    }
}
