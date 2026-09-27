// ============================================================
// 成长学习伙伴 · shared/schema.ts（v4）
// 位置：server/src/storage/database/shared/schema.ts
// 说明：v4「合表 + 多租户」完整重写，整体替换原文件。
// 依据：数据库重新设计-v4.md §C / migrations/0002_fresh_schema.sql
// ============================================================

import {
  pgTable, varchar, text, timestamp, jsonb, integer, bigint,
  boolean, serial, index, uniqueIndex,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

// ---------- health_check：平台探活（保留） ----------
export const healthCheck = pgTable("health_check", {
  id: serial().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow(),
});

// ---------- users：用户（匿名可读写，1 天后清理） ----------
export const users = pgTable("users", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  open_id: varchar("open_id", { length: 64 }).unique(),
  nickname: varchar("nickname", { length: 64 }),
  avatar_url: text("avatar_url"),
  is_anonymous: boolean("is_anonymous").notNull().default(false),
  expire_at: timestamp("expire_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("users_anon_expire_idx").on(table.expire_at),
]);

// ---------- subjects：学科（每用户独立） ----------
export const subjects = pgTable("subjects", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  user_id: varchar("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 32 }).notNull(),
  color: varchar("color", { length: 16 }).notNull().default("gray-500"),
  sort_order: integer("sort_order").notNull().default(0),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("subjects_user_name_idx").on(table.user_id, table.name),
  index("subjects_user_sort_idx").on(table.user_id, table.sort_order),
]);

// ---------- timeline_items：统一收件箱（最近题目 / 复习本） ----------
export const timelineItems = pgTable("timeline_items", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  user_id: varchar("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  subject_id: varchar("subject_id", { length: 36 }).references(() => subjects.id, { onDelete: "set null" }),
  kind: varchar("kind", { length: 16 }).notNull(),               // 'image' | 'question'
  title: text("title"),
  file_key: text("file_key"),
  thumb_key: text("thumb_key"),
  mime_type: varchar("mime_type", { length: 64 }),
  width: integer("width"),
  height: integer("height"),
  size_bytes: bigint("size_bytes", { mode: "number" }),
  file_hash: varchar("file_hash", { length: 64 }),
  content: jsonb("content").$type<{
    question?: string; answer?: string; solution?: string;
    wrong_answer?: string; images?: string[]; status?: string;
  }>().notNull().default(sql`'{}'::jsonb`),
  source: varchar("source", { length: 24 }),
  in_review_book: boolean("in_review_book").notNull().default(false),
  added_to_review_at: timestamp("added_to_review_at", { withTimezone: true }),
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  mastered: boolean("mastered").notNull().default(false),
  mastered_at: timestamp("mastered_at", { withTimezone: true }),
  deleted_at: timestamp("deleted_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("timeline_user_created_idx").on(table.user_id, table.created_at),
  index("timeline_review_idx").on(table.user_id, table.added_to_review_at),
  index("timeline_subject_idx").on(table.user_id, table.subject_id),
  index("timeline_hash_idx").on(table.user_id, table.file_hash),
  // 注：GIN(tags) 与部分索引（where deleted_at is null）在 SQL 脚本中建
]);

// ---------- library_docs：资料库（外部文档） ----------
export const libraryDocs = pgTable("library_docs", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  user_id: varchar("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  subject_id: varchar("subject_id", { length: 36 }).references(() => subjects.id, { onDelete: "set null" }),
  name: varchar("name", { length: 128 }).notNull(),
  file_key: text("file_key").notNull(),
  thumb_key: text("thumb_key"),                                 // 缩略图（WebP，宽<=400）
  mime_type: varchar("mime_type", { length: 64 }),
  width: integer("width"),
  height: integer("height"),
  size_bytes: bigint("size_bytes", { mode: "number" }),
  file_hash: varchar("file_hash", { length: 64 }),               // sha256，内容去重
  source: varchar("source", { length: 24 }),
  tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
  deleted_at: timestamp("deleted_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("library_user_created_idx").on(table.user_id, table.created_at),
  index("library_hash_idx").on(table.user_id, table.file_hash),
]);

// ---------- documents：文档页（小程序生成） ----------
export const documents = pgTable("documents", {
  id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
  user_id: varchar("user_id", { length: 36 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 128 }).notNull(),
  type: varchar("type", { length: 8 }).notNull(),                // 'docx'|'pdf'
  file_key: text("file_key").notNull(),
  mime_type: varchar("mime_type", { length: 64 }),
  size_bytes: bigint("size_bytes", { mode: "number" }),
  file_hash: varchar("file_hash", { length: 64 }),               // sha256，内容去重
  meta: jsonb("meta").notNull().default(sql`'{}'::jsonb`),
  deleted_at: timestamp("deleted_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("documents_user_created_idx").on(table.user_id, table.created_at),
  index("documents_hash_idx").on(table.user_id, table.file_hash),
]);

// ---------- blob_objects：内容寻址 + 引用计数（全局去重） ----------
// 依据：复习本与项目设计.md §11.3 策略 4
// content_hash 作主键 ⇒ 同一份内容再多用户也只占一个对象存储对象；
// ref_count 归零才真删文件 ⇒ 跨用户共享的文件不会被误删。
export const blobObjects = pgTable("blob_objects", {
  content_hash: varchar("content_hash", { length: 64 }).primaryKey(), // sha256 hex
  storage_key: text("storage_key").notNull(),                        // 主对象 key
  ref_count: integer("ref_count").notNull().default(0),              // 引用计数
  size_bytes: bigint("size_bytes", { mode: "number" }),
  mime_type: varchar("mime_type", { length: 64 }),
  kind: varchar("kind", { length: 16 }).notNull().default("image"),  // 'image' | 'doc'
  width: integer("width"),
  height: integer("height"),
  variants: jsonb("variants").notNull().default(sql`'{}'::jsonb`),   // { original, display, thumb }
  created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  last_ref_at: timestamp("last_ref_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("blob_created_idx").on(table.created_at),
  index("blob_gc_idx").on(table.ref_count, table.last_ref_at),
]);
