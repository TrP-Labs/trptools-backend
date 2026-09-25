import type { ApplicationModel } from './model'

type Question = ApplicationModel.questionInput
type Imported = { name: string; description: string; questions: Question[]; skipped: string[] }

function object(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function str(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

/** Converts the documented Google Forms API Form resource into an editable draft. */
export function parseGoogleForm(json: string): Imported {
    if (json.length > 262_144 || new TextEncoder().encode(json).byteLength > 262_144) {
        throw new Error('Google Form JSON is too large (256 KB maximum)')
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(json)
    } catch {
        throw new Error('Google Form JSON is invalid')
    }

    const form = object(parsed)
    const info = object(form?.info)
    const name = str(info?.title)
    if (!name || !Array.isArray(form?.items)) {
        throw new Error('Expected a Google Forms API form with info.title and items')
    }
    if (name.length > 100) throw new Error('Google Form title exceeds 100 characters')
    if (form.items.length > 100) throw new Error('Google Form has too many items (100 maximum)')

    const description = str(info?.description)
    if (description.length > 2000) throw new Error('Google Form description exceeds 2000 characters')

    const questions: Question[] = []
    const skipped: string[] = []

    for (const [index, raw] of form.items.entries()) {
        const item = object(raw)
        const title = str(item?.title)
        const label = title || `Item ${index + 1}`
        const hint = str(item?.description)
        if (title.length > 300 || hint.length > 1000) {
            skipped.push(`${label.slice(0, 80)}: text is too long`)
            continue
        }

        let question: Question | null = null
        const questionItem = object(item?.questionItem)
        const source = object(questionItem?.question)
        const hasImage = Boolean(questionItem?.image)
        const choice = object(source?.choiceQuestion)
        const text = object(source?.textQuestion)
        if (source && title && text && !hasImage) {
            question = {
                type: text.paragraph === true ? 'LONG_TEXT' : 'SHORT_TEXT',
                prompt: title,
                description: hint,
                required: source.required === true
            }
        } else if (source && title && choice && !hasImage) {
            const rawOptions = choice.options
            const choices = Array.isArray(rawOptions)
                ? rawOptions.map((value) => object(value))
                : []
            const type = choice.type === 'CHECKBOX' ? 'CHECKBOXES'
                : choice.type === 'RADIO' || choice.type === 'DROP_DOWN' ? 'MULTIPLE_CHOICE' : null
            const valid = type && choices.length > 0 && choices.length <= 20 &&
                choices.every((option) => option && !option.isOther && !option.goToSectionId && !option.goToAction &&
                    str(option.value).length > 0 && str(option.value).length <= 120)
            if (valid) {
                question = {
                    type,
                    prompt: title,
                    description: hint,
                    required: source.required === true,
                    options: choices.map((option) => str(option?.value))
                }
            }
        } else if (title && (item?.pageBreakItem || item?.textItem)) {
            question = { type: 'SECTION', prompt: title, description: hint }
        }

        if (question) questions.push(question)
        else skipped.push(`${label.slice(0, 80)}: unsupported question or option type`)
    }

    if (questions.length === 0) throw new Error('Google Form has no supported items to import')
    if (questions.length > 50) throw new Error('Google Form has more than 50 supported items')

    return { name, description, questions, skipped }
}
