// @ts-nocheck
import { pgTable, serial, timestamp, index, unique, varchar, integer, foreignKey, text, jsonb, boolean, bigint } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const healthCheck = pgTable("health_check", {
	id: serial().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

export const subjectsLegacy = pgTable("subjects_legacy", {
	id: varchar({ length: 36 }).default(gen_random_uuid()).primaryKey().notNull(),
	name: varchar({ length: 50 }).notNull(),
	color: varchar({ length: 30 }).default('gray-500').notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("subjects_sort_order_idx").using("btree", table.sortOrder.asc().nullsLast().op("int4_ops")),
	unique("subjects_name_unique").on(table.name),
]);

export const questionsLegacy = pgTable("questions_legacy", {
	id: varchar({ length: 36 }).default(gen_random_uuid()).primaryKey().notNull(),
	subjectId: varchar("subject_id", { length: 36 }).notNull(),
	questionContent: text("question_content").notNull(),
	questionImageKeys: jsonb("question_image_keys").default([]).notNull(),
	answerContent: text("answer_content").default('').notNull(),
	answerImageKeys: jsonb("answer_image_keys").default([]).notNull(),
	solution: text().default('').notNull(),
	wrongAnswer: text("wrong_answer").default('').notNull(),
	source: varchar({ length: 100 }).default('').notNull(),
	status: varchar({ length: 20 }).default('answered').notNull(),
	recognizedAt: timestamp("recognized_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	mastered: boolean().default(false).notNull(),
	masteredAt: timestamp("mastered_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("questions_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("questions_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("questions_subject_created_idx").using("btree", table.subjectId.asc().nullsLast().op("text_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("questions_subject_id_idx").using("btree", table.subjectId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.subjectId],
			foreignColumns: [subjectsLegacy.id],
			name: "questions_subject_id_subjects_id_fk"
		}).onDelete("cascade"),
]);

export const materialsLegacy = pgTable("materials_legacy", {
	id: varchar({ length: 36 }).default(gen_random_uuid()).primaryKey().notNull(),
	name: varchar({ length: 255 }).notNull(),
	type: varchar({ length: 20 }).default('image').notNull(),
	fileKey: varchar("file_key", { length: 500 }).notNull(),
	url: text().notNull(),
	mimeType: varchar("mime_type", { length: 100 }).default('').notNull(),
	sizeBytes: integer("size_bytes").default(0).notNull(),
	subjectId: varchar("subject_id", { length: 36 }),
	used: boolean().default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("materials_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("materials_type_idx").using("btree", table.type.asc().nullsLast().op("text_ops")),
]);

export const documentsLegacy = pgTable("documents_legacy", {
	id: varchar({ length: 36 }).default(gen_random_uuid()).primaryKey().notNull(),
	title: varchar({ length: 255 }).notNull(),
	type: varchar({ length: 20 }).default('docx').notNull(),
	fileKey: varchar("file_key", { length: 500 }).notNull(),
	url: text().notNull(),
	mimeType: varchar("mime_type", { length: 100 }).default('').notNull(),
	sizeBytes: integer("size_bytes").default(0).notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("documents_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamp_ops")),
]);

export const users = pgTable("users", {
	id: varchar({ length: 36 }).default(gen_random_uuid()).primaryKey().notNull(),
	openId: varchar("open_id", { length: 64 }),
	nickname: varchar({ length: 64 }),
	avatarUrl: text("avatar_url"),
	isAnonymous: boolean("is_anonymous").default(false).notNull(),
	expireAt: timestamp("expire_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("users_anon_expire_idx").using("btree", table.expireAt.asc().nullsLast().op("timestamptz_ops")).where(sql`is_anonymous`),
	unique("users_open_id_key").on(table.openId),
]);

export const timelineItems = pgTable("timeline_items", {
	id: varchar({ length: 36 }).default(gen_random_uuid()).primaryKey().notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	subjectId: varchar("subject_id", { length: 36 }),
	kind: varchar({ length: 16 }).notNull(),
	title: text(),
	fileKey: text("file_key"),
	thumbKey: text("thumb_key"),
	mimeType: varchar("mime_type", { length: 64 }),
	width: integer(),
	height: integer(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }),
	fileHash: varchar("file_hash", { length: 64 }),
	content: jsonb().default({}).notNull(),
	source: varchar({ length: 24 }),
	inReviewBook: boolean("in_review_book").default(false).notNull(),
	addedToReviewAt: timestamp("added_to_review_at", { withTimezone: true, mode: 'string' }),
	tags: text().array().default([""]).notNull(),
	mastered: boolean().default(false).notNull(),
	masteredAt: timestamp("mastered_at", { withTimezone: true, mode: 'string' }),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("timeline_hash_idx").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.fileHash.asc().nullsLast().op("text_ops")),
	index("timeline_review_idx").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.addedToReviewAt.desc().nullsFirst().op("text_ops")).where(sql`(in_review_book AND (deleted_at IS NULL))`),
	index("timeline_subject_idx").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.subjectId.asc().nullsLast().op("text_ops")),
	index("timeline_tags_gin").using("gin", table.tags.asc().nullsLast().op("array_ops")),
	index("timeline_user_created_idx").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")).where(sql`(deleted_at IS NULL)`),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "timeline_items_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.subjectId],
			foreignColumns: [subjects.id],
			name: "timeline_items_subject_id_fkey"
		}).onDelete("set null"),
]);

export const libraryDocs = pgTable("library_docs", {
	id: varchar({ length: 36 }).default(gen_random_uuid()).primaryKey().notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	subjectId: varchar("subject_id", { length: 36 }),
	name: varchar({ length: 128 }).notNull(),
	fileKey: text("file_key").notNull(),
	mimeType: varchar("mime_type", { length: 64 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }),
	source: varchar({ length: 24 }),
	tags: text().array().default([""]).notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	thumbKey: text("thumb_key"),
	width: integer(),
	height: integer(),
	fileHash: varchar("file_hash", { length: 64 }),
}, (table) => [
	index("library_hash_idx").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.fileHash.asc().nullsLast().op("text_ops")),
	index("library_user_created_idx").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("text_ops")).where(sql`(deleted_at IS NULL)`),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "library_docs_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.subjectId],
			foreignColumns: [subjects.id],
			name: "library_docs_subject_id_fkey"
		}).onDelete("set null"),
]);

export const documents = pgTable("documents", {
	id: varchar({ length: 36 }).default(gen_random_uuid()).primaryKey().notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	title: varchar({ length: 128 }).notNull(),
	type: varchar({ length: 8 }).notNull(),
	fileKey: text("file_key").notNull(),
	mimeType: varchar("mime_type", { length: 64 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }),
	meta: jsonb().default({}).notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	fileHash: varchar("file_hash", { length: 64 }),
}, (table) => [
	index("documents_hash_idx").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.fileHash.asc().nullsLast().op("text_ops")),
	index("documents_user_created_idx").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("text_ops")).where(sql`(deleted_at IS NULL)`),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "documents_user_id_fkey"
		}).onDelete("cascade"),
]);

export const blobObjects = pgTable("blob_objects", {
	contentHash: varchar("content_hash", { length: 64 }).primaryKey().notNull(),
	storageKey: text("storage_key").notNull(),
	refCount: integer("ref_count").default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }),
	mimeType: varchar("mime_type", { length: 64 }),
	kind: varchar({ length: 16 }).default('image').notNull(),
	width: integer(),
	height: integer(),
	variants: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastRefAt: timestamp("last_ref_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	originalBytes: bigint("original_bytes", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	thumbBytes: bigint("thumb_bytes", { mode: "number" }),
}, (table) => [
	index("blob_created_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("blob_gc_idx").using("btree", table.refCount.asc().nullsLast().op("int4_ops"), table.lastRefAt.asc().nullsLast().op("int4_ops")).where(sql`(ref_count = 0)`),
]);

export const subjects = pgTable("subjects", {
	id: varchar({ length: 36 }).default(gen_random_uuid()).primaryKey().notNull(),
	userId: varchar("user_id", { length: 36 }).notNull(),
	name: varchar({ length: 32 }).notNull(),
	color: varchar({ length: 16 }).default('gray-500').notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "subjects_user_id_fkey"
		}).onDelete("cascade"),
	unique("subjects_user_id_name_key").on(table.userId, table.name),
]);

export const userQuota = pgTable("user_quota", {
	userId: text("user_id").primaryKey().notNull(),
	tier: varchar({ length: 20 }).default('free').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	quotaBytes: bigint("quota_bytes", { mode: "number" }).default(524288000).notNull(),
	quotaCount: integer("quota_count").default(300).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	monthlyBytes: bigint("monthly_bytes", { mode: "number" }).default(209715200).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	usedBytes: bigint("used_bytes", { mode: "number" }).default(0).notNull(),
	usedCount: integer("used_count").default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("user_quota_tier_idx").using("btree", table.tier.asc().nullsLast().op("text_ops")),
]);

export const knowledgeArticles = pgTable("knowledge_articles", {
	id: varchar({ length: 36 }).default(gen_random_uuid()).primaryKey().notNull(),
	title: varchar({ length: 255 }).notNull(),
	content: text().notNull(),
	category: varchar({ length: 64 }),
	tags: text().array().default([]).notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("knowledge_tags_gin").using("gin", table.tags.asc().nullsLast().op("array_ops")),
]);

export const chatMessages = pgTable("chat_messages", {
	id: varchar({ length: 36 }).default(gen_random_uuid()).primaryKey().notNull(),
	sessionId: varchar("session_id", { length: 36 }).notNull(),
	userId: varchar("user_id", { length: 36 }),
	role: varchar({ length: 20 }).notNull(),
	content: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("chat_session_created_idx").using("btree", table.sessionId.asc().nullsLast().op("text_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")),
]);
