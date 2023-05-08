#!/usr/bin/env node
import * as path from 'path';
import * as xmljs from 'xml-js';
import * as fs from 'fs';
import {glob} from 'glob';
import {parse} from 'yaml';
import {get, last, set, upperFirst, startCase} from 'lodash';
import {Element} from 'xml-js';

const outputPath = './.run';

const basePath = './tools/run';
const templatedPath = path.join(basePath, 'template.xml');

const envsPath = path.join(basePath, 'envs');
const envs = glob.sync(path.join(envsPath, '*.yml'));

const templateString = fs.readFileSync(templatedPath).toString();
const template = xmljs.xml2js(templateString);

const applicationJavas = glob.sync(path.join('./', '**', '*Application.java'), {
	realpath: true,
});

if (!fs.existsSync(outputPath)) {
	fs.mkdirSync(outputPath);
}

function extractPackageName(path: string): string | null {
	// 将路径中的反斜杠转换为正斜杠
	path = path.replace(/\\/g, '/');

	// 匹配路径中的 Java 包名部分
	const match = path.match(/.*\/src\/(main|test)\/java\/(.*)\/.*$/);

	// 如果找到匹配项，则返回包名
	if (match && match.length === 3) {
		return match![2]!.replace(/\//g, '.');
	}

	// 没有找到匹配项则返回 null
	return null;
}

function extractGradleProjectName(path: string): string | null {
	// 将路径中的反斜杠转换为正斜杠
	path = path.replace(/\\/g, '/');
	const match = path
		.replace(/\/src\/.*/, '')
		.split('/')
		.join('.');
	return `parent.${match}.main`;
}

applicationJavas.map(applicationJava => {
	const fileName = path.basename(applicationJava);
	const packageName = extractPackageName(applicationJava);
	const gradleProjectName = extractGradleProjectName(applicationJava);
	if (!packageName || !gradleProjectName) {
		console.error('无法解析包名', applicationJava);
		return;
	}

	const appName = last(
		gradleProjectName.replace('parent.', '').replace('.main', '').split('.'),
	);

	if (!appName) {
		console.error(
			`无法解析应用名 ${gradleProjectName} ${applicationJava} ${packageName} ${appName} ${fileName} ${applicationJava}`,
		);
		return;
	}

	for (const env of envs) {
		const envName = upperFirst(path.basename(env).replace('.yml', ''));
		const currentName = startCase(`${appName}${envName}`).split(' ').join('');
		const currentTemplate = JSON.parse(JSON.stringify(template)) as Element;

		set(
			currentTemplate,
			'elements[0].elements[0].attributes.name',
			currentName,
		);

		const envDocument = parse(fs.readFileSync(env).toString());

		const envElement: Element = {
			attributes: {},
			cdata: '',
			comment: '',
			declaration: {},
			doctype: '',
			elements: [],
			instruction: '',
			name: 'envs',
			text: undefined,
			type: 'element',
		};
		Object.keys(envDocument).map(key => {
			const value = get(envDocument, key);
			envElement.elements?.push({
				attributes: {
					name: key,
					value: value,
				},
				cdata: '',
				comment: '',
				declaration: {},
				doctype: '',
				elements: [],
				instruction: '',
				name: 'env',
				text: undefined,
				type: 'element',
			} as Element);
		});

		const key = 'elements[0].elements[0].elements';
		const elements = get(currentTemplate, key, []);
		set(currentTemplate, key, [envElement, ...elements]);

		const findSpringMainClassOptions = get(currentTemplate, key, []).findIndex(
			(element: Element) => {
				return (
					element.name === 'option' &&
					get(element, 'attributes.name') === 'SPRING_BOOT_MAIN_CLASS'
				);
			},
		);
		if (findSpringMainClassOptions === -1) {
			console.error('无法找到 Spring Boot Main Class');
			return;
		}
		const optionKey = `${key}[${findSpringMainClassOptions}]`;
		set(
			currentTemplate,
			`${optionKey}.attributes.value`,
			`${packageName}.${fileName.replace('.java', '')}`,
		);

		const findModule = get(currentTemplate, key, []).findIndex(
			(element: Element) => {
				return element.name === 'module';
			},
		);
		if (findModule === -1) {
			console.error('无法找到 module');
			return;
		}
		const moduleKey = `${key}[${findModule}]`;
		set(currentTemplate, `${moduleKey}.attributes.name`, gradleProjectName);

		const outputFileName = `${currentName}.run.xml`;
		const outputFullPath = path.join(outputPath, outputFileName);

		console.log('输出', outputFullPath);

		fs.writeFileSync(
			outputFullPath,
			xmljs.js2xml(currentTemplate, {compact: false, spaces: 4}),
		);
	}
});
