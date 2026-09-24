import { pgTable, serial, varchar, text, timestamp, jsonb, integer, boolean, index } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"


export const healthCheck = pgTable("health_check", {
	id: serial().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

// 学科表：错题本上的学科索引
export const subjects = pgTable("subjects", {
	id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
	name: varchar("name", { length: 50 }).notNull().unique(),
	color: varchar("color", { length: 30 }).notNull().default('gray-500'),
	sort_order: integer("sort_order").notNull().default(0),
	created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	index("subjects_sort_order_idx").on(table.sort_order),
])

// 题目表：一道题目及其正确答案/解析
export const questions = pgTable("questions", {
	id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
	subject_id: varchar("subject_id", { length: 36 }).notNull().references(() => subjects.id, { onDelete: "cascade" }),
	question_content: text("question_content").notNull(),
	question_image_keys: jsonb("question_image_keys").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
	answer_content: text("answer_content").notNull().default(''),
	answer_image_keys: jsonb("answer_image_keys").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
	solution: text("solution").notNull().default(''),
	wrong_answer: text("wrong_answer").notNull().default(''),
	source: varchar("source", { length: 100 }).notNull().default(''),
	// answered: 已有正确答案；pending: 暂无答案待联网检索
	status: varchar("status", { length: 20 }).notNull().default('answered'),
	// 掌握标记：true 表示已掌握，默认不进入汇总文档，可用 include_mastered 开关重新纳入
	mastered: boolean("mastered").notNull().default(false),
	mastered_at: timestamp("mastered_at", { withTimezone: true }),
	recognized_at: timestamp("recognized_at", { withTimezone: true }).defaultNow().notNull(),
	created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	index("questions_subject_id_idx").on(table.subject_id),
	index("questions_created_at_idx").on(table.created_at),
	index("questions_status_idx").on(table.status),
	index("questions_subject_created_idx").on(table.subject_id, table.created_at),
])

// 素材表：导入的图片/文档原件统一归档，供后续重复使用
export const materials = pgTable("materials", {
	id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
	name: varchar("name", { length: 255 }).notNull(),
	// image: 图片素材；document: 文档素材
	type: varchar("type", { length: 20 }).notNull().default('image'),
	file_key: varchar("file_key", { length: 500 }).notNull(),
	url: text("url").notNull(),
	mime_type: varchar("mime_type", { length: 100 }).notNull().default(''),
	size_bytes: integer("size_bytes").notNull().default(0),
	// 可选：关联学科
	subject_id: varchar("subject_id", { length: 36 }),
	// 是否已被用于识别
	used: boolean("used").notNull().default(false),
	created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
	index("materials_type_idx").on(table.type),
	index("materials_created_at_idx").on(table.created_at),
])
