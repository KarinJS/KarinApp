package com.karinjs.karin

import android.database.Cursor
import android.database.MatrixCursor
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileNotFoundException

/** 通过 Storage Access Framework 将容器根文件系统暴露给系统文件管理器。 */
class DocumentsProvider : android.provider.DocumentsProvider() {

  companion object {
    const val AUTHORITY = "com.karinjs.karin.documents"
    private const val ROOT_ID = "container"
    private const val DOCUMENT_ID_ROOT = "root"
    private const val MIME_ROOT = DocumentsContract.Root.MIME_TYPE_ITEM
    private const val MIME_DIR = DocumentsContract.Document.MIME_TYPE_DIR
    private const val MIME_OCTET = "application/octet-stream"

    private val ROOT_PROJECTION = arrayOf(
      DocumentsContract.Root.COLUMN_ROOT_ID,
      DocumentsContract.Root.COLUMN_DOCUMENT_ID,
      DocumentsContract.Root.COLUMN_TITLE,
      "mime_type",
      DocumentsContract.Root.COLUMN_SUMMARY,
      DocumentsContract.Root.COLUMN_FLAGS,
      DocumentsContract.Root.COLUMN_ICON,
      DocumentsContract.Root.COLUMN_AVAILABLE_BYTES,
    )

    private val DOCUMENT_PROJECTION = arrayOf(
      DocumentsContract.Document.COLUMN_DOCUMENT_ID,
      DocumentsContract.Document.COLUMN_DISPLAY_NAME,
      DocumentsContract.Document.COLUMN_MIME_TYPE,
      DocumentsContract.Document.COLUMN_SIZE,
      DocumentsContract.Document.COLUMN_LAST_MODIFIED,
    )
  }

  private val rootDir: File
    get() = File(context?.filesDir ?: throw IllegalStateException("context 不可用"), "debian-rootfs")

  private fun resolveRootProjection(projection: Array<out String>?): Array<String> {
    if (projection == null) return ROOT_PROJECTION
    @Suppress("UNCHECKED_CAST")
    return projection as Array<String>
  }

  private fun resolveDocumentProjection(projection: Array<out String>?): Array<String> {
    if (projection == null) return DOCUMENT_PROJECTION
    @Suppress("UNCHECKED_CAST")
    return projection as Array<String>
  }

  private fun documentIdToFile(documentId: String): File {
    val root = rootDir.canonicalFile
    val file =
      if (documentId == DOCUMENT_ID_ROOT) root
      else File(root, documentId.removePrefix("$DOCUMENT_ID_ROOT/")).canonicalFile
    if (!file.path.startsWith(root.path)) throw FileNotFoundException("非法路径: $documentId")
    return file
  }

  private fun fileToDocumentId(file: File): String {
    val root = rootDir.canonicalFile
    val rel = root.toURI().relativize(file.toURI()).path
    return if (rel.isEmpty()) DOCUMENT_ID_ROOT else "$DOCUMENT_ID_ROOT/$rel"
  }

  private fun mimeOf(file: File): String =
    if (file.isDirectory) MIME_DIR
    else MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase()) ?: MIME_OCTET

  private fun formatBytes(bytes: Long): String {
    if (bytes < 0) return "未知"
    val kb = 1024.0
    val mb = kb * 1024
    val gb = mb * 1024
    return when {
      bytes >= gb -> String.format(java.util.Locale.US, "%.1f GB", bytes / gb)
      bytes >= mb -> String.format(java.util.Locale.US, "%.1f MB", bytes / mb)
      bytes >= kb -> String.format(java.util.Locale.US, "%.1f KB", bytes / kb)
      else -> "$bytes B"
    }
  }

  private fun put(row: Array<Any?>, columns: Array<String>, col: String, value: Any?) {
    val index = columns.indexOf(col)
    if (index >= 0) row[index] = value
  }

  private fun addDocumentRow(cursor: MatrixCursor, file: File) {
    val columns = cursor.columnNames
    val row = arrayOfNulls<Any>(columns.size)
    put(row, columns, DocumentsContract.Document.COLUMN_DOCUMENT_ID, fileToDocumentId(file))
    put(row, columns, DocumentsContract.Document.COLUMN_DISPLAY_NAME, file.name)
    put(row, columns, DocumentsContract.Document.COLUMN_MIME_TYPE, mimeOf(file))
    put(row, columns, DocumentsContract.Document.COLUMN_SIZE, if (file.isDirectory) null else file.length())
    put(row, columns, DocumentsContract.Document.COLUMN_LAST_MODIFIED, file.lastModified())
    cursor.addRow(row)
  }

  override fun onCreate(): Boolean = true

  override fun queryRoots(projection: Array<out String>?): Cursor {
    val cursor = MatrixCursor(resolveRootProjection(projection))
    val columns = cursor.columnNames
    val row = arrayOfNulls<Any>(columns.size)
    put(row, columns, DocumentsContract.Root.COLUMN_ROOT_ID, ROOT_ID)
    put(row, columns, DocumentsContract.Root.COLUMN_DOCUMENT_ID, DOCUMENT_ID_ROOT)
    put(row, columns, DocumentsContract.Root.COLUMN_TITLE, "Container")
    put(row, columns, "mime_type", MIME_ROOT)
    put(row, columns, DocumentsContract.Root.COLUMN_SUMMARY, "共 ${formatBytes(rootDir.totalSpace)}，可用 ${formatBytes(rootDir.usableSpace)}")
    put(row, columns, DocumentsContract.Root.COLUMN_ICON, R.mipmap.ic_launcher)
    put(
      row, columns, DocumentsContract.Root.COLUMN_FLAGS,
      DocumentsContract.Root.FLAG_LOCAL_ONLY or
        DocumentsContract.Root.FLAG_SUPPORTS_CREATE or
        DocumentsContract.Root.FLAG_SUPPORTS_IS_CHILD,
    )
    put(row, columns, DocumentsContract.Root.COLUMN_AVAILABLE_BYTES, rootDir.usableSpace)
    cursor.addRow(row)
    return cursor
  }

  override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor {
    val file = documentIdToFile(documentId)
    if (!file.exists()) throw FileNotFoundException("文件不存在: $documentId")
    val cursor = MatrixCursor(resolveDocumentProjection(projection))
    addDocumentRow(cursor, file)
    return cursor
  }

  override fun queryChildDocuments(
    parentDocumentId: String,
    projection: Array<out String>?,
    sortOrder: String?,
  ): Cursor {
    val parent = documentIdToFile(parentDocumentId)
    if (!parent.isDirectory && !parent.exists()) {
      return MatrixCursor(resolveDocumentProjection(projection))
    }
    if (!parent.isDirectory) throw FileNotFoundException("不是目录: $parentDocumentId")
    val cursor = MatrixCursor(resolveDocumentProjection(projection))
    val children = parent.listFiles() ?: emptyArray()
    for (child in children) {
      if (!child.canRead()) continue
      addDocumentRow(cursor, child)
    }
    val resolver = context?.contentResolver
    if (resolver != null) {
      cursor.setNotificationUri(
        resolver,
        DocumentsContract.buildChildDocumentsUri(AUTHORITY, parentDocumentId),
      )
    }
    return cursor
  }

  override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean {
    val parent = documentIdToFile(parentDocumentId)
    val child = documentIdToFile(documentId)
    return child.path == parent.path || child.path.startsWith("${parent.path}${File.separator}")
  }

  override fun openDocument(
    documentId: String,
    mode: String,
    signal: CancellationSignal?,
  ): ParcelFileDescriptor {
    val file = documentIdToFile(documentId)
    return ParcelFileDescriptor.open(file, ParcelFileDescriptor.parseMode(mode))
  }

  override fun createDocument(parentDocumentId: String, mimeType: String, displayName: String): String {
    val parent = documentIdToFile(parentDocumentId)
    val target = File(parent, displayName)
    val created = if (MIME_DIR == mimeType) target.mkdirs() else target.createNewFile()
    if (!created) throw FileNotFoundException("无法创建: $displayName")
    return fileToDocumentId(target)
  }

  override fun deleteDocument(documentId: String) {
    val file = documentIdToFile(documentId)
    if (!file.delete() && file.exists()) throw FileNotFoundException("删除失败: $documentId")
  }

  override fun renameDocument(documentId: String, displayName: String): String? {
    val file = documentIdToFile(documentId)
    val target = File(file.parentFile ?: rootDir, displayName)
    if (!file.renameTo(target)) throw FileNotFoundException("重命名失败: $documentId")
    return fileToDocumentId(target)
  }
}