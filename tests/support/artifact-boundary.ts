import ts from 'typescript';

/** FW01: runtime text artifacts must cross the redaction boundary; filesystem types cannot enforce this. */
export function artifactBoundaryViolations(file: string, text: string): string[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const writes = new Set<string>();
    const violations: string[] = [];
    const owners: Record<string, string[]> = { 'artifacts.ts': ['writeArtifact', 'redactTrace'], 'recording.ts': ['createRecordingStore'], 'cli.ts': ['initCommand'] };
    const allowed = new Set(owners[file] ?? []);
    const mutation = /^(?:write|append|createWriteStream|open|copyFile)/;
    const report = (node: ts.Node) => violations.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: filesystem writes must use writeArtifact (FW01)`);
    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !/^(?:node:)?fs(?:\/promises)?$/.test(statement.moduleSpecifier.text)) { continue; }
        const bindings = statement.importClause?.namedBindings;
        if (statement.importClause?.name || (bindings && ts.isNamespaceImport(bindings))) { report(statement); continue; }
        if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) { if (mutation.test((element.propertyName ?? element.name).text)) { writes.add(element.name.text); } }
        }
    }
    function visit(node: ts.Node): void {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && writes.has(node.expression.text)) {
            let owner: ts.Node | undefined = node.parent;
            while (owner && !ts.isFunctionDeclaration(owner)) { owner = owner.parent; }
            if (!owner || !ts.isFunctionDeclaration(owner) || !owner.name || !allowed.has(owner.name.text)) { report(node); }
        }
        // FW02: model and user-data boundaries cannot opt into result grammar preservation.
        if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
            && node.importClause.namedBindings.elements.some(entry => (entry.propertyName ?? entry.name).text === 'forResults')
            && !['suite.ts', 'test-runner.ts', 'report.ts'].includes(file)) {
            violations.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: forResults is restricted to engine result writers (FW02)`);
        }
        if (file === 'models.ts' && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
            && node.expression.name.text === 'value' && node.arguments.some(argument => ts.isIdentifier(argument) && argument.text === 'questions')) {
            violations.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: redact question descriptions without changing protocol identities (FW03)`);
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'writeReports'
            && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])
            && node.arguments[0].properties.some(property => property.name && ((ts.isIdentifier(property.name) && property.name.text === 'directory') || (ts.isStringLiteral(property.name) && property.name.text === 'directory')))) {
            violations.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: pass the physical report directory separately from redacted content (FW04)`);
        }
        ts.forEachChild(node, visit);
    }
    visit(source);
    return violations;
}
