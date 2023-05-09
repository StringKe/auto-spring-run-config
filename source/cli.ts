#!/usr/bin/env node
import * as path from 'path';
import * as xmljs from 'xml-js';
import {Element} from 'xml-js';
import * as fs from 'fs';
import globby from 'fast-glob';
import {parse} from 'yaml';
import {first, get, last, set, startCase, upperFirst} from 'lodash';
import * as os from "os";
import findFreePorts from "find-free-ports"
import * as process from "process";
import packageJSON from "../package.json";

let usedPorts: number[] = [];

console.log("Version: ", packageJSON.version)
const isFree = async (port: number) => {
	if (usedPorts.includes(port)) {
		return false
	}
	usedPorts.push(port)
	return await findFreePorts.isFreePort(port)
}

function getIpv4s() {
	const interfaces = os.networkInterfaces();
	const addresses = [];
	for (const k in interfaces) {
		const kind2 = get(interfaces, k);
		if (kind2) {
			for (const k2 in kind2) {
				const address = get(kind2, k2);
				if (address && address.family === 'IPv4' && !address.internal) {
					addresses.push(address.address);
				}
			}
		}
	}
	return first(addresses.filter((address) => {
		if (address.startsWith('127.')) {
			return false;
		}
		return !address.startsWith('198.18');
	})) || '127.0.0.1';
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

async function valueHook(value: string | null | number | boolean) {
	if (value && value.toString().startsWith("HOOK")) {
		if (value.toString().startsWith("HOOK_IP")) {
			return getIpv4s();

		} else if (value.toString().startsWith("HOOK_PORT")) {
			return first(await findFreePorts(1, {
				startPort: 10000,
				endPort: 30000,
				isFree,
			})) || value.toString().replace("HOOK_PORT", "");
		}
	}
	return value;
}

async function bootstrap() {
	const outputPath = path.join(process.cwd(), '.run')
	console.log('outputPath', outputPath)

	const basePath = path.join(process.cwd(), 'tools', 'run')
	console.log('basePath', basePath)
	const templatedPath = path.join(basePath, 'template.xml');
	console.log('templatedPath', templatedPath)

	const envsPath = path.join(basePath, 'envs', '*');
	console.log('envsPath', envsPath)
	const envs = (await globby(envsPath, {})).filter((env) => {
		return env.endsWith('.yml') || env.endsWith('.yaml')
	})
	console.log('envs', envs)

	if (!fs.existsSync(templatedPath)) {
		console.error('找不到模板文件', templatedPath);
		return;
	}

	const templateString = fs.readFileSync(templatedPath).toString();
	console.log('templateString', templateString)
	const template = xmljs.xml2js(templateString);

	const scanFilePath = path.join(process.cwd(), '**', '*Application.java');
	console.log('scanFilePath', scanFilePath)
	const applicationJavas = await globby(scanFilePath, {})
	console.log('applicationJavas', applicationJavas)

	if (!fs.existsSync(outputPath)) {
		fs.mkdirSync(outputPath);
	}

	const all = applicationJavas.map(async (applicationJava) => {
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
			const allowed = Object.keys(envDocument).map(async (key) => {
				const value = await valueHook(get(envDocument, key));

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

			await Promise.all(allowed);

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

	await Promise.all(all);
}

void bootstrap();
