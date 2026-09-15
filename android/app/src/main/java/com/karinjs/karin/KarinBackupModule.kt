package com.karinjs.karin

import android.app.Activity
import android.content.Intent
import android.net.Uri
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.*
import com.facebook.react.uimanager.ViewManager
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.*
import java.security.MessageDigest
import java.util.UUID
import java.util.Collections
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.CancellationException
import java.util.concurrent.Executors
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream
import java.nio.file.Files
import org.json.JSONArray
import org.json.JSONObject

/** Karin instance backup import/export. Archive marker must live at ZIP root. */
class KarinBackupModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context), ActivityEventListener {
  private val executor = Executors.newSingleThreadExecutor()
  private val cancelledTasks = Collections.synchronizedSet(mutableSetOf<String>())
  private var pending: Pair<String, Promise>? = null
  private data class ExportTotals(val files: Int, val bytes: Long)
  companion object { const val PICK_EXPORT = 0x4B80; const val PICK_IMPORT = 0x4B81; const val MARKER = ".karin-backup.json"; const val MAGIC = "KARIN_BACKUP" }
  init { context.addActivityEventListener(this) }
  override fun getName() = "KarinBackup"

  @ReactMethod fun startExport(options: ReadableMap?, promise: Promise) {
    val uri = options?.takeIf { it.hasKey("destinationUri") && !it.isNull("destinationUri") }?.getString("destinationUri")
    val only = options?.takeIf { it.hasKey("pluginListOnly") }?.getBoolean("pluginListOnly") ?: false
    if (uri != null) exportToUri(uri, only, promise) else pickExport(options?.takeIf { it.hasKey("fileName") }?.getString("fileName"), promise)
  }
  /** 只负责打开系统选择器；选定 URI 后由 JS 先预览，再调用 importFromUri。 */
  @ReactMethod fun startImport(promise: Promise) = pickImport(promise)
  @ReactMethod fun getActiveTask(promise: Promise) = listPendingTasks(promise)
  @ReactMethod fun resumeTask(taskId: String, overwrite: Boolean, promise: Promise) {
    val task = File(context.filesDir, "import-tasks/$taskId"); val src = File(task, "source.zip")
    if (!src.isFile) { promise.reject("BACKUP_TASK_MISSING", "找不到导入任务"); return }
    importFromLocalZip(taskId, src, overwrite, promise)
  }
  @ReactMethod fun discardTask(taskId: String, promise: Promise) = cancelImport(taskId, promise)

  @ReactMethod fun pickExport(fileName: String?, promise: Promise) {
    if (pending != null) { promise.reject("BACKUP_BUSY", "已有文件选择任务"); return }
    val a = reactApplicationContext.currentActivity ?: run { promise.reject("NO_ACTIVITY", "应用不在前台"); return }
    pending = "export" to promise
    val i = Intent(Intent.ACTION_CREATE_DOCUMENT).apply { addCategory(Intent.CATEGORY_OPENABLE); type = "application/zip"; putExtra(Intent.EXTRA_TITLE, fileName ?: defaultBackupFileName()) }
    try { a.startActivityForResult(i, PICK_EXPORT) } catch (e: Exception) { pending=null; promise.reject("PICK_FAILED", e) }
  }
  @ReactMethod fun pickImport(promise: Promise) {
    if (pending != null) { promise.reject("BACKUP_BUSY", "已有文件选择任务"); return }
    val a = reactApplicationContext.currentActivity ?: run { promise.reject("NO_ACTIVITY", "应用不在前台"); return }
    pending = "import" to promise
    val i = Intent(Intent.ACTION_OPEN_DOCUMENT).apply { addCategory(Intent.CATEGORY_OPENABLE); type = "application/zip"; putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/zip", "application/octet-stream", "application/x-zip-compressed")) }
    try { a.startActivityForResult(i, PICK_IMPORT) } catch (e: Exception) { pending=null; promise.reject("PICK_FAILED", e) }
  }
  override fun onActivityResult(a: Activity, code: Int, result: Int, data: Intent?) {
    if (code != PICK_EXPORT && code != PICK_IMPORT) return
    val p = pending?.second ?: return; val kind = pending?.first; pending=null
    if (result != Activity.RESULT_OK || data?.data == null) { p.resolve(null); return }; p.resolve(data.data.toString())
  }
  override fun onNewIntent(intent: Intent) = Unit

  private fun defaultBackupFileName(): String = "karin-backup-${SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US).format(Date())}.zip"

  @ReactMethod fun exportToUri(uriString: String, pluginListOnly: Boolean, promise: Promise) = runAsync(promise, "BACKUP_EXPORT_FAILED") {
    val root = File(RootfsInstaller(context).ensureContainer(), "root/karin").canonicalFile
    if (!File(root, "package.json").isFile) throw IllegalStateException("Karin 根目录不存在 package.json")
    val uri = Uri.parse(uriString); val resolver = context.contentResolver
    val git = JSONArray(); var count=0; var bytes=0L
    val totals = countTree(root, root, pluginListOnly)
    resolver.openOutputStream(uri, "w")?.use { os -> ZipOutputStream(BufferedOutputStream(os)).use { zip ->
      val marker = JSONObject().apply { put("magic", MAGIC); put("formatVersion", 1); put("rootDir", "/"); put("pluginListOnly", pluginListOnly) }
      if (pluginListOnly) marker.put("gitPlugins", git)
      addTree(root, root, zip, pluginListOnly, git) { p, n -> count++; bytes += n; emitExportProgress(p, count, totals.files, bytes, totals.bytes) }
      if (pluginListOnly) { val m = JSONObject().apply { put("magic", MAGIC); put("formatVersion",1); put("rootDir", "/"); put("pluginListOnly", true); put("gitPlugins", git) }; putText(zip, MARKER, m.toString(2)) }
      else { val m = JSONObject().apply { put("magic", MAGIC); put("formatVersion",1); put("rootDir", "/"); put("pluginListOnly", false) }; putText(zip, MARKER, m.toString(2)) }
    } } ?: throw IOException("无法写入目标文件")
    Arguments.createMap().apply { putDouble("files", count.toDouble()); putDouble("bytes", bytes.toDouble()); putString("uri", uriString) }
  }

  @ReactMethod fun inspectImport(uriString: String, promise: Promise) = runAsync(promise, "BACKUP_INSPECT_FAILED") { inspect(Uri.parse(uriString)) }

  @ReactMethod fun prepareImport(uriString: String, promise: Promise) = runAsync(promise, "BACKUP_IMPORT_PREPARE_FAILED") {
    val task = UUID.randomUUID().toString(); val dir = File(context.filesDir, "import-tasks/$task"); val staging = File(dir, "staging"); val rollback = File(dir, "rollback"); dir.mkdirs(); staging.mkdirs(); rollback.mkdirs()
    val info = inspect(Uri.parse(uriString)); val source = info.getString("sourceRoot") ?: throw IllegalArgumentException("备份缺少有效 rootDir"); val entries = extract(Uri.parse(uriString), source, staging, dir); File(dir,"source-uri").writeText(uriString); writeState(dir,"prepared",0,entries.size)
    Arguments.createMap().apply { putString("taskId",task); putString("rootDir",source); putInt("files",entries.size); putArray("conflicts",Arguments.createArray().apply { entries.filter { File(File(RootfsInstaller(context).ensureContainer(),"root/karin"),it).exists() }.forEach { pushString(it) } }) }
  }
  @ReactMethod fun resolveConflict(taskId:String,path:String,action:String,applyAll:Boolean,promise:Promise) = runAsync(promise,"BACKUP_CONFLICT_FAILED") { val d=File(context.filesDir,"import-tasks/$taskId"); require(d.canonicalPath.startsWith(File(context.filesDir,"import-tasks").canonicalPath)); File(d,"conflicts.json").appendText(JSONObject().put("path",path).put("action",action).put("applyAll",applyAll).toString()+"\n"); true }
  @ReactMethod fun commitImport(taskId:String,promise:Promise) = runAsync(promise,"BACKUP_IMPORT_COMMIT_FAILED") { commitTask(taskId) }
  @ReactMethod fun finishTask(taskId:String,promise:Promise) = runAsync(promise,"BACKUP_TASK_FINISH_FAILED") { File(context.filesDir,"import-tasks/$taskId").deleteRecursively(); true }

  @ReactMethod fun importFromUri(uriString: String, overwrite: Boolean, promise: Promise) = runAsync(promise, "BACKUP_IMPORT_FAILED") {
    val task = UUID.randomUUID().toString(); val dir = File(context.filesDir, "import-tasks/$task"); val staging = File(dir, "staging"); val rollback = File(dir, "rollback"); dir.mkdirs(); staging.mkdirs(); rollback.mkdirs(); writeState(dir, "running", 0, 0)
    try {
      val info = inspect(Uri.parse(uriString)); val source = info.getString("sourceRoot") ?: throw IllegalArgumentException("备份缺少有效 rootDir"); val entries = extract(Uri.parse(uriString), source, staging, dir)
      val target = File(RootfsInstaller(context).ensureContainer(), "root/karin").canonicalFile; target.mkdirs(); var done=0
      for (rel in entries) { if (cancelledTasks.contains(task)) throw CancellationException("导入已取消"); val s=File(staging, rel); val d=File(target, rel); if (d.exists() && !overwrite) { emitLog(task, "跳过重复文件: $rel"); continue }; emitLog(task, "正在恢复: $rel"); if (d.exists()) { val b=File(rollback, rel); b.parentFile?.mkdirs(); copyAny(d,b) }; d.parentFile?.mkdirs(); s.copyTo(d, true); File(dir,"journal.ndjson").appendText(rel+"\n"); done++; writeState(dir,"running",done,entries.size); emitProgress("import", rel, done, entries.size.toLong()) }
      runGitPlugins(task, info, overwrite)
      writeState(dir,"done",done,entries.size); dir.deleteRecursively(); Arguments.createMap().apply { putString("taskId", task); putInt("files", done) }
    } catch (e: Exception) { rollbackTask(dir); writeState(dir,if (e is CancellationException) "cancelled" else "failed",0,0); throw e }
  }
  private fun commitTask(taskId:String):WritableMap { val dir=File(context.filesDir,"import-tasks/$taskId"); require(dir.isDirectory); val staging=File(dir,"staging"); val rollback=File(dir,"rollback"); val target=File(RootfsInstaller(context).ensureContainer(),"root/karin").canonicalFile; val files=staging.walkTopDown().filter{it.isFile}.map{it.relativeTo(staging).invariantSeparatorsPath}.toList(); var done=0; for(rel in files){ val s=File(staging,rel); val d=File(target,rel); if(d.exists()){ val b=File(rollback,rel); b.parentFile?.mkdirs(); copyAny(d,b) }; d.parentFile?.mkdirs(); val tmp=File(d.parentFile,".${d.name}.karin-tmp"); s.copyTo(tmp,true); if(!tmp.renameTo(d)){ tmp.delete(); throw IOException("无法原子替换 $rel") }; File(dir,"journal.ndjson").appendText(rel+"\n"); done++; writeState(dir,"committing",done,files.size); emitProgress("commit",rel,done,files.size.toLong()) }; writeState(dir,"committed",done,files.size); return Arguments.createMap().apply{putString("taskId",taskId);putInt("files",done)} }
  private fun importFromLocalZip(taskId: String, zipFile: File, overwrite: Boolean, promise: Promise) = runAsync(promise, "BACKUP_IMPORT_FAILED") {
    val dir = File(context.filesDir, "import-tasks/$taskId"); val staging = File(dir, "staging"); val rollback = File(dir, "rollback"); staging.mkdirs(); rollback.mkdirs()
    val info = inspectLocal(zipFile); val source = info.getString("sourceRoot") ?: throw IllegalArgumentException("备份缺少有效 rootDir"); val entries = extractLocal(zipFile, source, staging)
    val target = File(RootfsInstaller(context).ensureContainer(), "root/karin").canonicalFile; target.mkdirs(); var done=0
    for (rel in entries) { if (cancelledTasks.contains(taskId)) throw CancellationException("导入已取消"); val s=File(staging, rel); val d=File(target, rel); if (d.exists() && !overwrite) { emitLog(taskId, "跳过重复文件: $rel"); continue }; emitLog(taskId, "正在恢复: $rel"); if (d.exists()) { val b=File(rollback, rel); b.parentFile?.mkdirs(); copyAny(d,b) }; d.parentFile?.mkdirs(); s.copyTo(d,true); File(dir,"journal.ndjson").appendText(rel+"\n"); done++; writeState(dir,"running",done,entries.size); emitProgress("import",rel,done,entries.size.toLong()) }
    writeState(dir,"done",done,entries.size); dir.deleteRecursively(); Arguments.createMap().apply { putString("taskId",taskId); putInt("files",done) }
  }
  private fun inspectLocal(file:File):WritableMap = ZipFile(file).use { z ->
    val e=z.getEntry(MARKER) ?: throw IllegalArgumentException("不是 Karin 备份：根目录缺少 $MARKER")
    if (z.entries().asSequence().any { it.name.substringAfterLast('/').equals(MARKER, true) && it.name != MARKER }) throw IllegalArgumentException("子目录中的 $MARKER 无效")
    val m=JSONObject(z.getInputStream(e).bufferedReader().readText())
    if(m.optString("magic")!=MAGIC) throw IllegalArgumentException("备份标识无效")
    if (!m.has("rootDir") || m.isNull("rootDir") || m.opt("rootDir") !is String) throw IllegalArgumentException("备份标识缺少有效 rootDir")
    val rootValue = m.getString("rootDir")
    if (rootValue.isBlank()) throw IllegalArgumentException("备份标识缺少有效 rootDir")
    val root=normalize(rootValue); val prefix=if(root.isEmpty())"" else "$root/"
    if(z.entries().asSequence().none { it.name.equals(prefix+"package.json", true) }) throw IllegalArgumentException("rootDir 下缺少 package.json")
    val target=File(RootfsInstaller(context).ensureContainer(),"root/karin").canonicalFile
    val conflicts=Arguments.createArray(); var files=0
    z.entries().asSequence().forEach { entry ->
      if (!entry.isDirectory && underRoot(entry.name, root)) {
        val rel=entry.name.substring(prefix.length)
        if (rel.isNotEmpty() && !excluded(rel) && rel != MARKER) { files++; if (File(target, rel).exists()) conflicts.pushString(rel) }
      }
    }
    m.optJSONArray("gitPlugins")?.let { gitPlugins ->
      for (i in 0 until gitPlugins.length()) {
        val path = gitPlugins.optJSONObject(i)?.optString("path", "") ?: ""
        if (path.isNotBlank() && File(target, path).exists()) conflicts.pushString(path)
      }
    }
    Arguments.createMap().apply{putString("sourceRoot",root);putInt("files",files);putArray("conflicts",conflicts);putBoolean("pluginListOnly",m.optBoolean("pluginListOnly"));putString("gitPluginsJson",m.optJSONArray("gitPlugins")?.toString() ?: "[]")}
  }
  private fun extractLocal(file:File,source:String,staging:File):List<String>{ val prefix=if(source.isEmpty())"" else "$source/"; val out=mutableListOf<String>(); ZipFile(file).use{z->z.entries().asSequence().forEach{e->if(e.isDirectory||!underRoot(e.name,source))return@forEach; val rel=if(prefix.isEmpty())e.name else e.name.substring(prefix.length); if(rel==MARKER||excluded(rel))return@forEach; val safe=safeRel(rel); val f=File(staging,safe);f.parentFile?.mkdirs();z.getInputStream(e).use{i->f.outputStream().use{o->i.copyTo(o)}};out+=safe}};return out }
  @ReactMethod fun listPendingTasks(promise: Promise) = runAsync(promise, "BACKUP_TASKS_FAILED") { val arr=Arguments.createArray(); val d=File(context.filesDir,"import-tasks"); d.listFiles()?.filter { File(it,"state.json").isFile }?.forEach { dir -> val state=JSONObject(File(dir,"state.json").readText()); arr.pushMap(Arguments.createMap().apply { putString("taskId", dir.name); putString("state", state.optString("state")); putInt("done", state.optInt("done")); putInt("total", state.optInt("total")); putArray("logs", Arguments.createArray().apply { File(dir,"logs.ndjson").takeIf { it.isFile }?.readLines()?.takeLast(500)?.forEach { pushString(it) } }) }) }; arr }
  @ReactMethod fun cancelImport(taskId: String, promise: Promise) {
    cancelledTasks.add(taskId)
    runAsync(promise, "BACKUP_CANCEL_FAILED") {
      val d=File(context.filesDir,"import-tasks/$taskId")
      if (d.isDirectory) rollbackTask(d)
      d.deleteRecursively(); cancelledTasks.remove(taskId); true
    }
  }

  private fun rollbackTask(d:File) {
    val target=File(RootfsInstaller(context).ensureContainer(),"root/karin"); val rb=File(d,"rollback")
    File(d,"journal.ndjson").takeIf{it.isFile}?.readLines()?.asReversed()?.forEach { rel ->
      if (rel.isBlank()) return@forEach
      val b=File(rb,rel); val t=File(target,rel)
      if (b.exists()) { t.deleteRecursively(); t.parentFile?.mkdirs(); copyAny(b,t) } else t.deleteRecursively()
    }
  }

  private fun copyAny(source:File, target:File) {
    if (source.isDirectory) source.copyRecursively(target, overwrite = true) else source.copyTo(target, overwrite = true)
  }

  private fun inspect(uri: Uri): WritableMap { val tmp=File(context.cacheDir,"backup-${UUID.randomUUID()}.zip"); context.contentResolver.openInputStream(uri)?.use { input -> tmp.outputStream().use { input.copyTo(it) } } ?: throw IOException("无法读取备份文件"); return try { inspectLocal(tmp) } finally { tmp.delete() } }
  private fun extract(uri: Uri, source: String, staging: File, dir: File): List<String> { val tmp=File(dir,"source.zip"); context.contentResolver.openInputStream(uri)!!.use { i -> tmp.outputStream().use { i.copyTo(it) } }; val prefix=if(source.isEmpty()) "" else "$source/"; val out=mutableListOf<String>(); ZipFile(tmp).use { z -> z.entries().asSequence().forEach { e -> if(e.isDirectory || !underRoot(e.name,source)) return@forEach; val rel=e.name.substring(prefix.length); if(rel==MARKER || excluded(rel)) return@forEach; val safe=safeRel(rel); val f=File(staging,safe); f.parentFile?.mkdirs(); z.getInputStream(e).use { i -> f.outputStream().use { i.copyTo(it) } }; out+=safe } }; return out }
  private fun normalize(s:String):String { var x=s.trim().replace('\\','/'); if(x.startsWith("file:") || Regex("^[A-Za-z]:.*").matches(x)) throw IllegalArgumentException("rootDir 路径无效"); x=x.trimStart('/'); while(x.contains("//")) x=x.replace("//","/"); if(x=="."||x.isEmpty()) return ""; if(x.split('/').any{it==".."||it.isEmpty()}) throw IllegalArgumentException("rootDir 路径无效"); return x.trimEnd('/') }
  private fun underRoot(name:String, root:String):Boolean { val n=name.trimEnd('/'); return root.isEmpty() || n.equals(root,true) || n.startsWith("$root/",true) }
  private fun safeRel(s:String):String { if(s.startsWith('/') || s.split('/').any{it==".."}) throw IllegalArgumentException("备份包含不安全路径"); return s }
  private fun excluded(s:String):Boolean { val p=s.split('/'); val logs=p.zipWithNext().any { (parent, child) -> parent.equals("@karinjs",true) && child.equals("logs",true) }; return logs || p.any { it.equals("node_modules",true)||it.equals(".pnpm-store",true)||it.equals(".cache",true)||it.equals(MARKER,true) } }
  private fun addTree(base:File, cur:File, z:ZipOutputStream, listOnly:Boolean, git:JSONArray, cb:(String,Long)->Unit) { cur.listFiles()?.forEach { f -> if (Files.isSymbolicLink(f.toPath())) return@forEach; val rel=f.relativeTo(base).invariantSeparatorsPath; if(excluded(rel)) return@forEach; if(rel.startsWith("plugins/") && listOnly && f.isDirectory && File(f,".git").isDirectory && !rel.equals("plugins/karin-plugin-example",true)) { git.put(JSONObject().apply { put("name",f.name); put("path",rel); put("url", gitUrl(f)); put("branch",gitBranch(f)); put("commit",gitCommit(f)) }); return@forEach }; if(f.isDirectory) addTree(base,f,z,listOnly,git,cb) else { val e=ZipEntry(rel); z.putNextEntry(e); f.inputStream().use{it.copyTo(z)}; z.closeEntry(); cb(rel,f.length()) } } }
  private fun gitUrl(f:File):String = runCatching { Regex("(?m)^\\s*url\\s*=\\s*(.+)$").find(File(f,".git/config").readText())?.groupValues?.get(1)?.trim() ?: "" }.getOrDefault("")
  private fun gitBranch(f:File):String = runCatching {
    val head = File(f,".git/HEAD").readText().trim()
    if (head.startsWith("ref: refs/heads/")) head.removePrefix("ref: refs/heads/") else ""
  }.getOrDefault("")
  private fun gitCommit(f:File):String = runCatching {
    val head=File(f,".git/HEAD").readText().trim(); if (!head.startsWith("ref: ")) head else {
      val ref=head.removePrefix("ref: "); val direct=File(f,".git/$ref"); if (direct.isFile) direct.readText().trim() else {
        Regex("(?m)^([0-9a-f]{40})\\s+$ref$").find(File(f,".git/packed-refs").takeIf{it.isFile}?.readText() ?: "")?.groupValues?.get(1) ?: ""
      }
    }
  }.getOrDefault("")
  private fun shellQuote(value:String):String = "'" + value.replace("'", "'\\''") + "'"
  private fun runGitPlugins(taskId:String, info:ReadableMap, overwrite:Boolean) {
    val raw = info.getString("gitPluginsJson") ?: "[]"
    val list = runCatching { JSONArray(raw) }.getOrElse { JSONArray() }
    if (list.length() == 0) return
    val root = RootfsInstaller(context).ensureContainer()
    val runtime = ProotRuntime(context)
    runtime.prepareRuntime(root)
    for (i in 0 until list.length()) {
      if (cancelledTasks.contains(taskId)) throw CancellationException("导入已取消")
      val item = list.optJSONObject(i) ?: continue
      val rel = item.optString("path", "")
      val url = item.optString("url", "")
      val branch = item.optString("branch", "")
      val commit = item.optString("commit", "")
      if (!rel.startsWith("plugins/", true) || rel.split('/').any { it.isEmpty() || it == "." || it == ".." } || url.isBlank() || commit.isBlank()) {
        emitLog(taskId, "跳过无效 Git 插件记录: $rel")
        continue
      }
      val existing = File(root, "root/karin/$rel")
      if (existing.exists() && !overwrite) {
        emitLog(taskId, "跳过重复 Git 插件: $rel")
        continue
      }
      val command = buildString {
        append("rm -rf ").append(shellQuote("/root/karin/$rel"))
        append(" && mkdir -p ").append(shellQuote("/root/karin/plugins"))
        append(" && git clone")
        if (branch.isNotBlank()) append(" --branch ").append(shellQuote(branch))
        append(' ').append(shellQuote(url)).append(' ').append(shellQuote("/root/karin/$rel"))
        append(" && git -C ").append(shellQuote("/root/karin/$rel")).append(" checkout ").append(shellQuote(commit))
      }
      emitLog(taskId, "正在克隆 Git 插件: $rel")
      try {
        val process = runtime.createGuestProcess(root, listOf("/bin/sh", "-c", command), true)
        process.inputStream.bufferedReader().useLines { lines -> lines.forEach { if (it.isNotBlank()) emitLog(taskId, it) } }
        val code = process.waitFor()
        if (code != 0) emitLog(taskId, "Git 插件失败（退出码 $code）: $rel") else emitLog(taskId, "Git 插件完成: $rel")
      } catch (error: Exception) {
        emitLog(taskId, "Git 插件失败: $rel (${error.message ?: "未知错误"})")
      }
    }
  }
  private fun putText(z:ZipOutputStream,n:String,t:String){z.putNextEntry(ZipEntry(n));z.write(t.toByteArray());z.closeEntry()}
  private fun countTree(base:File, cur:File, listOnly:Boolean):ExportTotals {
    var files = 0
    var bytes = 0L
    cur.listFiles()?.forEach { f ->
      if (Files.isSymbolicLink(f.toPath())) return@forEach
      val rel = f.relativeTo(base).invariantSeparatorsPath
      if (excluded(rel)) return@forEach
      if (rel.startsWith("plugins/") && listOnly && f.isDirectory && File(f, ".git").isDirectory && !rel.equals("plugins/karin-plugin-example", true)) return@forEach
      if (f.isDirectory) {
        val nested = countTree(base, f, listOnly)
        files += nested.files
        bytes += nested.bytes
      } else {
        files++
        bytes += f.length()
      }
    }
    return ExportTotals(files, bytes)
  }
  private fun writeState(d:File,state:String,done:Int,total:Int){ File(d,"state.json").writeText(JSONObject().apply{put("state",state);put("done",done);put("total",total);put("updatedAt",System.currentTimeMillis())}.toString()) }
  private fun emitProgress(stage:String,current:String,done:Int,total:Long){
    // WritableMap instances are consumed by the React Native bridge when emitted.
    // Each event therefore needs its own map; reusing one causes "Map already consumed"
    // on the second emit and leaves the export task stuck after the file picker returns.
    fun eventMap(): WritableMap = Arguments.createMap().apply {
      putString("stage",stage)
      putString("current",current)
      putInt("done",done)
      putDouble("total",total.toDouble())
    }
    val emitter = context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
    emitter.emit("KarinBackupProgress", eventMap())
    emitter.emit("KarinBackupTask", eventMap())
  }
  private fun emitExportProgress(current:String,completedFiles:Int,totalFiles:Int,completedBytes:Long,totalBytes:Long){
    fun eventMap(): WritableMap = Arguments.createMap().apply {
      putString("stage", "export")
      putString("current", current)
      putInt("completedFiles", completedFiles)
      putInt("totalFiles", totalFiles)
      putDouble("completedBytes", completedBytes.toDouble())
      putDouble("totalBytes", totalBytes.toDouble())
      putDouble("progress", if (totalBytes > 0) completedBytes.toDouble() / totalBytes else if (totalFiles > 0) completedFiles.toDouble() / totalFiles else 1.0)
    }
    val emitter = context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
    emitter.emit("KarinBackupProgress", eventMap())
    emitter.emit("KarinBackupTask", eventMap())
  }
  private fun emitLog(task:String,msg:String){
    File(context.filesDir,"import-tasks/$task").takeIf { it.isDirectory }?.let { dir ->
      runCatching { File(dir,"logs.ndjson").appendText(msg.replace("\n", " ")+"\n") }
    }
    context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("KarinBackupLog",Arguments.createMap().apply{putString("taskId",task);putString("message",msg)})
  }
  private fun <T> runAsync(p:Promise,code:String,block:()->T){ executor.execute{try{p.resolve(block())}catch(e:Exception){p.reject(code,e.message,e)}} }
}

class KarinBackupPackage : ReactPackage { override fun createNativeModules(c:ReactApplicationContext)=listOf<NativeModule>(KarinBackupModule(c)); override fun createViewManagers(c:ReactApplicationContext)=emptyList<ViewManager<*,*>>() }




