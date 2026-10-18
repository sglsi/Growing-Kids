import { relations } from "drizzle-orm/relations";
import { subjectsLegacy, questionsLegacy, users, timelineItems, subjects, libraryDocs, documents } from "./schema";

export const questionsLegacyRelations = relations(questionsLegacy, ({one}) => ({
	subjectsLegacy: one(subjectsLegacy, {
		fields: [questionsLegacy.subjectId],
		references: [subjectsLegacy.id]
	}),
}));

export const subjectsLegacyRelations = relations(subjectsLegacy, ({many}) => ({
	questionsLegacies: many(questionsLegacy),
}));

export const timelineItemsRelations = relations(timelineItems, ({one}) => ({
	user: one(users, {
		fields: [timelineItems.userId],
		references: [users.id]
	}),
	subject: one(subjects, {
		fields: [timelineItems.subjectId],
		references: [subjects.id]
	}),
}));

export const usersRelations = relations(users, ({many}) => ({
	timelineItems: many(timelineItems),
	libraryDocs: many(libraryDocs),
	documents: many(documents),
	subjects: many(subjects),
}));

export const subjectsRelations = relations(subjects, ({one, many}) => ({
	timelineItems: many(timelineItems),
	libraryDocs: many(libraryDocs),
	user: one(users, {
		fields: [subjects.userId],
		references: [users.id]
	}),
}));

export const libraryDocsRelations = relations(libraryDocs, ({one}) => ({
	user: one(users, {
		fields: [libraryDocs.userId],
		references: [users.id]
	}),
	subject: one(subjects, {
		fields: [libraryDocs.subjectId],
		references: [subjects.id]
	}),
}));

export const documentsRelations = relations(documents, ({one}) => ({
	user: one(users, {
		fields: [documents.userId],
		references: [users.id]
	}),
}));