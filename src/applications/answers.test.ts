import { describe, expect, test } from 'bun:test'
import { collectAnswers, type FormQuestion } from './answers'

const question = (overrides: Partial<FormQuestion> & Pick<FormQuestion, 'id' | 'type'>): FormQuestion => ({
    prompt: overrides.prompt ?? 'A question',
    required: false,
    order: 0,
    options: [],
    maxLength: null,
    ...overrides
})

describe('collectAnswers', () => {
    test('keeps text answers, trimmed, in form order', () => {
        const { answers, missing } = collectAnswers(
            [
                question({ id: 'b', type: 'SHORT_TEXT', prompt: 'Timezone', order: 1 }),
                question({ id: 'a', type: 'LONG_TEXT', prompt: 'Why', order: 0 })
            ],
            [
                { questionId: 'a', value: '  I like trolleybuses  ' },
                { questionId: 'b', value: 'GMT' }
            ]
        )

        expect(missing).toEqual([])
        expect(answers.map((answer) => [answer.questionId, answer.value])).toEqual([
            ['a', 'I like trolleybuses'],
            ['b', 'GMT']
        ])
    })

    test('drops the components that are read rather than answered', () => {
        const { answers } = collectAnswers(
            [
                question({ id: 'heading', type: 'SECTION', order: 0 }),
                question({ id: 'picture', type: 'IMAGE', order: 1 }),
                question({ id: 'q', type: 'SHORT_TEXT', order: 2 })
            ],
            [{ questionId: 'q', value: 'yes' }]
        )

        expect(answers.map((answer) => answer.questionId)).toEqual(['q'])
    })

    test('records only choices the form offers', () => {
        const { answers } = collectAnswers(
            [question({ id: 'q', type: 'CHECKBOXES', options: ['Main Island', 'Cat Island'] })],
            [{ questionId: 'q', choices: ['Main Island', 'Nowhere'] }]
        )

        expect(answers[0]?.choices).toEqual(['Main Island'])
    })

    test('a single-answer question keeps one choice however many arrive', () => {
        const { answers } = collectAnswers(
            [question({ id: 'q', type: 'MULTIPLE_CHOICE', options: ['Daily', 'Weekends only'] })],
            [{ questionId: 'q', choices: ['Daily', 'Weekends only'] }]
        )

        expect(answers[0]?.choices).toEqual(['Daily'])
    })

    test('reports a required question left empty, by prompt', () => {
        const { missing } = collectAnswers(
            [
                question({ id: 'a', type: 'SHORT_TEXT', prompt: 'Timezone', required: true }),
                question({ id: 'b', type: 'CHECKBOXES', prompt: 'Depots', required: true, options: ['One'] })
            ],
            [{ questionId: 'a', value: '   ' }]
        )

        expect(missing).toEqual(['Timezone', 'Depots'])
    })

    test('an unanswered optional question still records that it was asked', () => {
        const { answers, missing } = collectAnswers([question({ id: 'q', type: 'LONG_TEXT', prompt: 'Anything else?' })], [])

        expect(missing).toEqual([])
        expect(answers).toEqual([
            { questionId: 'q', prompt: 'Anything else?', type: 'LONG_TEXT', order: 0, value: '', choices: [] }
        ])
    })

    test('answers to questions this form does not ask are ignored', () => {
        const { answers } = collectAnswers(
            [question({ id: 'q', type: 'SHORT_TEXT' })],
            [
                { questionId: 'q', value: 'kept' },
                { questionId: 'someone-elses-form', value: 'dropped' }
            ]
        )

        expect(answers).toHaveLength(1)
        expect(answers[0]?.value).toBe('kept')
    })

    test('applies the length limit the form declares', () => {
        const { answers } = collectAnswers(
            [question({ id: 'q', type: 'SHORT_TEXT', maxLength: 5 })],
            [{ questionId: 'q', value: 'far too long' }]
        )

        expect(answers[0]?.value).toBe('far t')
    })
})
