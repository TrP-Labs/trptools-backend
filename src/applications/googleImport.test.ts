import { describe, expect, test } from 'bun:test'
import { parseGoogleForm } from './googleImport'

const example = JSON.stringify({
    formId: 'example',
    info: { title: 'Driver application', description: 'Tell us about your experience.' },
    items: [
        { title: 'About you', description: 'A short introduction', pageBreakItem: {} },
        { title: 'Why do you want to drive?', questionItem: { question: { required: true, textQuestion: { paragraph: true } } } },
        { title: 'Your depot', questionItem: { question: { required: true, choiceQuestion: {
            type: 'DROP_DOWN', options: [{ value: 'Main Island' }, { value: 'Cat Island' }]
        } } } },
        { title: 'Availability', questionItem: { question: { choiceQuestion: {
            type: 'CHECKBOX', options: [{ value: 'Weekdays' }, { value: 'Weekends' }]
        } } } },
        { title: 'Upload a certificate', questionItem: { question: { fileUploadQuestion: {} } } },
        { title: 'Identify this vehicle', questionItem: { question: { textQuestion: {} }, image: { contentUri: 'https://example.com/vehicle.png' } } }
    ]
})

describe('Google Forms API import', () => {
    test('maps supported items, preserves order and reports unsupported items', () => {
        const result = parseGoogleForm(example)
        expect(result.name).toBe('Driver application')
        expect(result.description).toBe('Tell us about your experience.')
        expect(result.questions.map((question) => question.type)).toEqual([
            'SECTION', 'LONG_TEXT', 'MULTIPLE_CHOICE', 'CHECKBOXES'
        ])
        expect(result.questions[1]?.required).toBe(true)
        expect(result.questions[2]?.options).toEqual(['Main Island', 'Cat Island'])
        expect(result.skipped).toEqual([
            'Upload a certificate: unsupported question or option type',
            'Identify this vehicle: unsupported question or option type'
        ])
    })

    test('does not convert branching or Other answers into misleading fixed choices', () => {
        const json = JSON.stringify({ info: { title: 'Test' }, items: [
            { title: 'Name', questionItem: { question: { textQuestion: {} } } },
            { title: 'Branch', questionItem: { question: { choiceQuestion: {
                type: 'RADIO', options: [{ value: 'Next', goToAction: 'NEXT_SECTION' }]
            } } } },
            { title: 'Other', questionItem: { question: { choiceQuestion: {
                type: 'RADIO', options: [{ value: 'Other', isOther: true }]
            } } } }
        ] })
        const result = parseGoogleForm(json)
        expect(result.questions).toHaveLength(1)
        expect(result.skipped).toHaveLength(2)
    })

    test('rejects malformed and empty forms', () => {
        expect(() => parseGoogleForm('{')).toThrow('invalid')
        expect(() => parseGoogleForm(JSON.stringify({ info: { title: 'Empty' }, items: [] }))).toThrow('no supported items')
        expect(() => parseGoogleForm(JSON.stringify({ info: { title: 'Test' }, items: [], padding: '🚌'.repeat(70_000) }))).toThrow('too large')
    })
})
