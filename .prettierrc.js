module.exports = {
	overrides: [
		{
			files: ["*.ts", "*.js"],
			options: {
				printWidth: 145,
				semi: false,
				tabWidth: 4,
				useTabs: false,
				singleQuote: false,
				bracketSpacing: true,
				trailingComma: "es5",
			},
		},
		{
			files: "*.sol",
			options: {
				printWidth: 300,
				tabWidth: 4,
				useTabs: false,
				singleQuote: false,
				bracketSpacing: false,
			},
		},
	],
};