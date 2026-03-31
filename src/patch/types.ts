export type ActionType = "add" | "delete" | "update";
export type ParseMode = "keep" | "add" | "delete";

export interface Chunk {
	origIndex: number;
	delLines: string[];
	insLines: string[];
}

export interface PatchAction {
	type: ActionType;
	newFile?: string;
	chunks: Chunk[];
	movePath?: string;
}

export interface ParsedPatchAction {
	type: ActionType;
	path: string;
	newFile?: string;
	lines?: string[];
	movePath?: string;
}

export interface ParserState {
	lines: string[];
	index: number;
	fuzz: number;
}

export interface ExecutePatchResult {
	changedFiles: string[];
	createdFiles: string[];
	deletedFiles: string[];
	movedFiles: string[];
	fuzz: number;
}

export class DiffError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DiffError";
	}
}

export class ExecutePatchError extends DiffError {
	result: ExecutePatchResult;
	failedAction?: ParsedPatchAction;

	constructor(message: string, result: ExecutePatchResult, failedAction?: ParsedPatchAction) {
		super(message);
		this.name = "ExecutePatchError";
		this.result = result;
		this.failedAction = failedAction;
	}

	hasPartialSuccess(): boolean {
		return (
			this.result.changedFiles.length > 0 ||
			this.result.createdFiles.length > 0 ||
			this.result.deletedFiles.length > 0 ||
			this.result.movedFiles.length > 0 ||
			this.result.fuzz > 0
		);
	}
}
