type GroupVisibility = { visibility: string; moderation: string; showRoutes: boolean }
type ItemVisibility = { visibility: string; moderation: string; archived: boolean }

export function publicGroupReadable(group: GroupVisibility): boolean {
    return group.visibility !== 'PRIVATE' && group.moderation !== 'HIDDEN'
}

export function publicItemReadable(group: GroupVisibility, item: ItemVisibility, kind: 'ROUTE' | 'DEPOT'): boolean {
    return publicGroupReadable(group) && (kind !== 'ROUTE' || group.showRoutes) &&
        item.visibility === 'PUBLIC' && item.moderation !== 'HIDDEN' && !item.archived
}
