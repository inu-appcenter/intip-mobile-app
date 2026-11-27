package expo.modules.notificationrelay

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** `src/config.ts`의 `RelayCategory` 와 같은 모양. */
data class RelayCategory(
  val id: String,
  val name: String,
  val keywords: List<String>,
  val importance: String,
  val drop: Boolean,
)

/** `src/config.ts`의 `NotificationRelayConfig` 중 Android가 쓰는 부분. */
data class RelayConfig(
  val enabled: Boolean,
  val sourcePackages: Set<String>,
  val cancelOriginal: Boolean,
  val categories: List<RelayCategory>,
  val fallback: RelayCategory,
) {
  /**
   * `classifyNotification`(src/config.ts)과 같은 규칙: 공백 제거 + 소문자로 비교하고,
   * 위에 있는 카테고리의 첫 키워드 매치가 이긴다. 안 걸리면 fallback.
   */
  fun classify(title: String?, body: String?): Pair<RelayCategory, String?> {
    val haystack = normalize("${title.orEmpty()}\n${body.orEmpty()}")
    for (category in categories) {
      for (keyword in category.keywords) {
        val needle = normalize(keyword)
        if (needle.isNotEmpty() && haystack.contains(needle)) return category to keyword
      }
    }
    return fallback to null
  }

  val allCategories: List<RelayCategory> get() = categories + fallback

  companion object {
    private const val PREFS = "intip_notification_relay"
    private const val KEY_CONFIG = "config"

    private val WHITESPACE = Regex("\\s+")
    fun normalize(text: String): String = text.replace(WHITESPACE, "").lowercase()

    private val DEFAULT_FALLBACK = RelayCategory("etc", "기타", emptyList(), "low", false)

    fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun readRaw(context: Context): String? = prefs(context).getString(KEY_CONFIG, null)

    fun writeRaw(context: Context, json: String): Boolean =
      prefs(context).edit().putString(KEY_CONFIG, json).commit()

    /** 저장된 설정이 없거나 깨졌으면 null — 그때 서비스는 아무것도 건드리지 않는다. */
    fun load(context: Context): RelayConfig? {
      val raw = readRaw(context) ?: return null
      return try {
        parse(JSONObject(raw))
      } catch (e: Exception) {
        null
      }
    }

    fun parse(json: JSONObject): RelayConfig {
      val android = json.optJSONObject("android") ?: JSONObject()
      val categories = json.optJSONArray("categories")?.let { parseCategories(it) } ?: emptyList()
      val fallback = json.optJSONObject("fallback")?.let { parseCategory(it) } ?: DEFAULT_FALLBACK
      return RelayConfig(
        enabled = json.optBoolean("enabled", false),
        sourcePackages = android.optJSONArray("sourcePackages")?.let { strings(it) }?.toSet() ?: emptySet(),
        cancelOriginal = android.optBoolean("cancelOriginal", true),
        categories = categories,
        fallback = fallback,
      )
    }

    private fun parseCategories(array: JSONArray): List<RelayCategory> =
      (0 until array.length()).mapNotNull { i -> array.optJSONObject(i)?.let { parseCategory(it) } }

    private fun parseCategory(obj: JSONObject) = RelayCategory(
      id = obj.optString("id", "etc"),
      name = obj.optString("name", "기타"),
      keywords = obj.optJSONArray("keywords")?.let { strings(it) } ?: emptyList(),
      importance = obj.optString("importance", "default"),
      drop = obj.optBoolean("drop", false),
    )

    private fun strings(array: JSONArray): List<String> =
      (0 until array.length()).mapNotNull { i -> array.optString(i, null) }
  }
}
