import { describe, expect, test } from 'bun:test'
import { mergeTranslations, presentTranslations } from './translations'

/**
 * The rules for folding a translation patch into what is stored.
 *
 * Every one of these is a small decision that loses somebody's words when it
 * is backwards — a field dropped because another form did not know about it,
 * a blank published as a name, a made-up key handed back to every reader.
 * Nothing here imports the database or the environment, so it runs in CI.
 */

describe('mergeTranslations', () => {
    test('leaves fields the patch does not mention alone', () => {
        const stored = { name: { uk: 'Маршрут' }, description: { uk: 'Опис' } }

        expect(mergeTranslations('ROUTE', stored, { name: { uk: 'Новий' } })).toEqual({
            name: { uk: 'Новий' },
            description: { uk: 'Опис' }
        })
    })

    test('replaces a mentioned field wholesale, so a deleted language goes', () => {
        const stored = { name: { uk: 'Маршрут', fr: 'Ligne' } }

        expect(mergeTranslations('ROUTE', stored, { name: { uk: 'Маршрут' } })).toEqual({
            name: { uk: 'Маршрут' }
        })
    })

    test('a blank value deletes rather than publishing an empty name', () => {
        const stored = { name: { uk: 'Маршрут' } }

        expect(mergeTranslations('ROUTE', stored, { name: { uk: '   ' } })).toEqual({})
    })

    test('trims, since a trailing space is not a different translation', () => {
        expect(mergeTranslations('ROUTE', null, { name: { uk: '  Маршрут  ' } })).toEqual({
            name: { uk: 'Маршрут' }
        })
    })

    test('drops a field this entity does not have', () => {
        expect(mergeTranslations('ROUTE', null, { tagline: { uk: 'Ні' } })).toEqual({})
    })

    test('drops a language the instance does not ship', () => {
        expect(mergeTranslations('ROUTE', null, { name: { zz: 'no' } })).toEqual({})
    })

    test('a patch of nothing changes nothing', () => {
        const stored = { name: { uk: 'Маршрут' } }
        expect(mergeTranslations('ROUTE', stored, undefined)).toEqual(stored)
    })

    test('question choices are keyed by position', () => {
        expect(
            mergeTranslations('QUESTION', null, { 'option:0': { uk: 'Так' }, 'option:99': { uk: 'ні' } })
        ).toEqual({ 'option:0': { uk: 'Так' } })
    })

    test('a choice key is only a choice key on a question', () => {
        expect(mergeTranslations('ROUTE', null, { 'option:0': { uk: 'Так' } })).toEqual({})
    })
})

describe('presentTranslations', () => {
    test('withholds a field the allow-list no longer recognises', () => {
        const stored = { name: { uk: 'Маршрут' }, retired: { uk: 'старе' } }

        expect(presentTranslations('ROUTE', stored)).toEqual({ name: { uk: 'Маршрут' } })
    })

    test('nothing stored is an empty object, never null', () => {
        expect(presentTranslations('ROUTE', null)).toEqual({})
    })
})
