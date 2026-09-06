export declare function buildTscExecInvocation(args: {
	npmCli: string;
	execPrefix: string;
	tsconfigProject: string;
}): {
	command: string;
	argv: string[];
	options: { cwd: string; stdio: "inherit" };
};

export declare function main(): void;
