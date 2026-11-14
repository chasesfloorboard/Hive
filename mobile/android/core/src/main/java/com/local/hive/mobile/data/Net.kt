package com.local.hive.mobile.data

import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/** The shared HTTP client for Hive's web lookups (Apple Music, Spotify, artwork, lyrics, radio…).
 *  A foundation utility so any layer can use it without reaching into the streaming code. */
fun defaultHttp(): OkHttpClient = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).build()
