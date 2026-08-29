import type { ApplicationQuestionType } from '../db/schema/enums'

/**
 * What an application form does with what somebody typed into it.
 *
 * Kept apart from the service, and importing one *type* and nothing else, so
 * the rules can be tested without a database or an environment — the same
 * reason `rooms/dispatch/assign.ts` is split from its solver. Every decision
 * here has an obvious wrong version: trusting the choices that arrive, letting
 * a single-answer question keep several, or reading "required" off the request
 * rather than off the form.
 */

/** Components that are read rather than answered. */
const STATIC_TYPES: ApplicationQuestionType[] = ['SECTION', 'IMAGE']

const CHOICE_TYPES: ApplicationQuestionType[] = ['MULTIPLE_CHOICE', 'CHECKBOXES']

export const isStatic = (type: ApplicationQuestionType) => STATIC_TYPES.includes(type)
export const isChoice = (type: ApplicationQuestionType) => CHOICE_TYPES.includes(type)

export type FormQuestion = {
    id: string
    type: ApplicationQuestionType
    prompt: string
    required: boolean
    order: number
    options: string[]
    maxLength: number | null
}

export type GivenAnswer = {
    questionId: string
    value?: string
    choices?: string[]
}

export type CollectedAnswer = {
    questionId: string
    prompt: string
    type: ApplicationQuestionType
    order: number
    value: string
    choices: string[]
}

export type Collected = {
    answers: CollectedAnswer[]
    /** Prompts of required questions left empty. Empty means the form is good. */
    missing: string[]
}

/**
 * Pairs a form up with what was sent for it.
 *
 * The **form** decides what is collected, never the request: an answer to a
 * question this form does not ask is dropped, a choice it does not offer is
 * dropped, and a question nobody answered still produces a row so the archive
 * shows what was asked and left blank.
 */
export function collectAnswers(questions: FormQuestion[], given: GivenAnswer[]): Collected {
    const byQuestion = new Map(given.map((answer) => [answer.questionId, answer]))

    const answers: CollectedAnswer[] = []
    const missing: string[] = []

    for (const question of [...questions].sort((a, b) => a.order - b.order)) {
        if (isStatic(question.type)) continue

        const answer = byQuestion.get(question.id)
        const choice = isChoice(question.type)

        const text = choice ? '' : (answer?.value ?? '').trim()

        // Only what the form offers is recorded, and a single-answer question
        // keeps one however many arrive.
        const picked = (answer?.choices ?? []).filter((option) => question.options.includes(option))
        const choices = question.type === 'MULTIPLE_CHOICE' ? picked.slice(0, 1) : picked

        const empty = choice ? choices.length === 0 : text.length === 0
        if (question.required && empty) missing.push(question.prompt)

        answers.push({
            questionId: question.id,
            prompt: question.prompt,
            type: question.type,
            order: question.order,
            // A limit the form declares is applied here as well as in the box,
            // because the box is the applicant's copy of the rule.
            value: question.maxLength ? text.slice(0, question.maxLength) : text,
            choices
        })
    }

    return { answers, missing }
}
