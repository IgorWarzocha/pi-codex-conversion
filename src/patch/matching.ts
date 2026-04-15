export function lineMatchFuzz(left: string, right: string): number | undefined {
	if (left === right) return 0;
	if (left.trimEnd() === right.trimEnd()) return 1;
	if (left.trim() === right.trim()) return 100;
	return undefined;
}

export function linesMatch(left: string, right: string): boolean {
	return lineMatchFuzz(left, right) !== undefined;
}

export function linesEqualFuzz({ left, right }: { left: string[]; right: string[] }): number | undefined {
	if (left.length !== right.length) return undefined;

	let fuzz = 0;
	for (let index = 0; index < left.length; index++) {
		const lineFuzz = lineMatchFuzz(left[index], right[index]);
		if (lineFuzz === undefined) return undefined;
		fuzz += lineFuzz;
	}

	return fuzz;
}
