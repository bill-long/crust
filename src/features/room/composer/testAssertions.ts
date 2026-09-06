export function requiredValue<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`${label} was missing`);
	return value;
}

export function requiredAt<T>(
	items: ArrayLike<T>,
	index: number,
	label = `composer item ${index}`,
): T {
	return requiredValue(items[index], label);
}
